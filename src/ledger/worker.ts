import { pool, tx } from '../db.js';
import { config } from '../config.js';
import { setupRequired } from '../environment.js';
import { activeNetworks, networks } from '../chain/networks.js';
import { bumpStuck } from '../chain/replace.js';
import { expirePending } from '../portal/obligations.js';
import { fiatTick } from '../fiat/service.js';
import type { Operator } from '../auth/operators.js';
import { LedgerError } from './service.js';
import { signReserved, broadcastSigned, confirmBroadcast, creditConfirmedDeposits, type Logger } from './transfers.js';
import { maintainSweeps, sweepStep } from './sweeps.js';
import { registerPendingAddresses } from './deposit-addresses.js';
import { currentSlot, MANUAL_POLICY, nextDue, type WorkerPolicy } from './worker-schedule.js';

type PolicyRow = WorkerPolicy & { client_id: string; next_due_at: Date | null; last_slot: string | null; revision: number };
const message = (e: unknown) => (e instanceof Error ? e.message : String(e)).split('\n')[0].slice(0, 1000);

/** El mismo candado de nonces/bump protege mantenimiento, disparos, recuperación y cambios de política. */
async function locked<T>(fn: () => Promise<T>) {
  if (config.DB_POOL_MAX < 2) throw new LedgerError(503, 'El worker requiere DB_POOL_MAX >= 2 (candado y transacciones)', 'worker_pool_size');
  const c = await pool.connect();
  let held = false;
  let destroy = false;
  try {
    held = (await c.query('SELECT pg_try_advisory_lock(856003) AS ok')).rows[0].ok;
    if (!held) throw new LedgerError(409, 'Worker en curso en otra ejecución; reintente después', 'worker_busy');
    return await fn();
  } finally {
    try {
      if (held) await c.query('SELECT pg_advisory_unlock(856003)');
    } catch (e) {
      destroy = true;
      throw e;
    } finally { c.release(destroy); }
  }
}

export async function assertWorkerEnabled() {
  if (!config.WORKER_ENABLED) throw new LedgerError(409, 'Worker deshabilitado globalmente (WORKER_ENABLED)', 'worker_disabled');
  if (await setupRequired()) throw new LedgerError(503, 'Servicio en modo de alta', 'setup_required');
}

export async function workerClients(search = '', limit = 100) {
  return (await pool.query(
    `SELECT c.id, c.name, c.status, COALESCE(p.mode, 'manual') AS mode
       FROM clients c LEFT JOIN worker_policies p ON p.client_id = c.id
      WHERE c.name ILIKE '%' || $1 || '%' OR c.id::text = $1
      ORDER BY c.name, c.id LIMIT $2`, [search, limit])).rows;
}

export async function workerClient(clientId: string) {
  const { rows: [client] } = await pool.query('SELECT id, name, status FROM clients WHERE id = $1', [clientId]);
  if (!client) throw new LedgerError(404, 'Cliente no encontrado', 'not_found');
  const { rows: [policy] } = await pool.query('SELECT * FROM worker_policies WHERE client_id = $1', [clientId]);
  const { rows: runs } = await pool.query(
    'SELECT * FROM worker_runs WHERE client_id = $1 ORDER BY started_at DESC, id DESC LIMIT 30', [clientId]);
  const { rows: usage } = await pool.query(
    `SELECT metric, sum(qty)::text AS qty FROM usage_daily
      WHERE provider = 'worker' AND metric LIKE $1
        AND day >= date_trunc('month', now() AT TIME ZONE 'UTC')::date GROUP BY metric`,
    [`client:${clientId}:%`]);
  return {
    client, policy: policy ?? { ...MANUAL_POLICY, client_id: clientId, revision: 0, next_due_at: null, last_slot: null },
    runs, usage, worker_enabled: config.WORKER_ENABLED, setup_required: await setupRequired(),
  };
}

export async function saveWorkerPolicy(clientId: string, policy: WorkerPolicy, revision: number, operator: Operator) {
  await locked(() => tx(async (c) => {
    const { rows: [cl] } = await c.query('SELECT status FROM clients WHERE id = $1 FOR SHARE', [clientId]);
    if (!cl) throw new LedgerError(404, 'Cliente no encontrado', 'not_found');
    if (cl.status !== 'active' && policy.mode !== 'manual') throw new LedgerError(409, 'Solo clientes activos pueden programarse', 'client_not_active');
    const { rows: [previous] } = await c.query('SELECT * FROM worker_policies WHERE client_id = $1 FOR UPDATE', [clientId]);
    if ((previous?.revision ?? 0) !== revision) throw new LedgerError(409, 'La política cambió; recargue antes de guardar', 'policy_changed');
    const now = (await c.query('SELECT now() AS now')).rows[0].now as Date;
    const lastSlot = previous?.last_slot ?? null;
    const due = nextDue(policy, now, lastSlot);
    await c.query(
      `INSERT INTO worker_policies (client_id, mode, interval_minutes, timezone, windows, next_due_at, updated_by, last_slot)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (client_id) DO UPDATE SET mode = EXCLUDED.mode, interval_minutes = EXCLUDED.interval_minutes,
       timezone = EXCLUDED.timezone, windows = EXCLUDED.windows, next_due_at = EXCLUDED.next_due_at,
       revision = worker_policies.revision + 1, updated_by = EXCLUDED.updated_by, updated_at = now()`,
      [clientId, policy.mode, policy.interval_minutes, policy.timezone, JSON.stringify(policy.windows), due, operator.id, lastSlot]);
    await c.query(
      `INSERT INTO audit_log (operator_id, actor, action, target, client_id, status, metadata)
       VALUES ($1,$2,'worker_policy_changed',$3::uuid::text,$3::uuid,200,$4)`,
      [operator.id, operator.email, clientId, { previous: previous ?? MANUAL_POLICY, policy, next_due_at: due }]);
  }));
  return workerClient(clientId);
}

async function recoverInterrupted() {
  // Con el candado adquirido ninguna ejecución anterior puede seguir siendo dueña del worker.
  await tx(async (c) => {
    const { rows } = await c.query(
      `WITH lost AS (
         UPDATE worker_runs SET status = 'interrupted', finished_at = now(), error = 'Proceso interrumpido; no se repite automáticamente'
          WHERE status = 'running' RETURNING id, client_id
       ), audited AS (
         INSERT INTO audit_log (actor, action, target, client_id, status, metadata)
         SELECT 'worker', 'worker_run_interrupted', id::text, client_id, 500, '{}'::jsonb FROM lost
       )
       SELECT p.*, now() AS clock FROM worker_policies p JOIN lost l ON l.client_id = p.client_id`);
    for (const p of rows) {
      await c.query('UPDATE worker_policies SET next_due_at = $2 WHERE client_id = $1',
        [p.client_id, nextDue(p, p.clock, p.last_slot)]);
    }
  });
}

async function executeClient(clientId: string, log: Logger, manual?: { operator: Operator; requestId: string }) {
  const claim = await tx(async (c) => {
    if (manual) {
      const { rows: [old] } = await c.query('SELECT * FROM worker_runs WHERE client_id = $1 AND request_id = $2', [clientId, manual.requestId]);
      if (old) return { run: old, replay: true };
    }
    const { rows: [client] } = await c.query('SELECT status FROM clients WHERE id = $1 FOR SHARE', [clientId]);
    if (!client) throw new LedgerError(404, 'Cliente no encontrado', 'not_found');
    if (client.status !== 'active') throw new LedgerError(409, 'Cliente no activo', 'client_not_active');
    await c.query('INSERT INTO worker_policies (client_id) VALUES ($1) ON CONFLICT DO NOTHING', [clientId]);
    const { rows: [p] } = await c.query<PolicyRow>('SELECT * FROM worker_policies WHERE client_id = $1 FOR UPDATE', [clientId]);
    const now = (await c.query('SELECT now() AS now')).rows[0].now as Date;
    const slot = p.mode === 'scheduled' ? currentSlot(p, now) : null;
    if (!manual) {
      if (p.mode === 'manual' || !p.next_due_at || p.next_due_at > now) return null;
      if (p.mode === 'scheduled' && (!slot || slot === p.last_slot)) {
        await c.query('UPDATE worker_policies SET next_due_at = $2 WHERE client_id = $1', [clientId, nextDue(p, now, p.last_slot)]);
        return null;
      }
    }
    const trigger = manual ? 'manual' : p.mode;
    const { rows: [run] } = await c.query(
      `INSERT INTO worker_runs (client_id, request_id, trigger, policy_revision, operator_id)
       VALUES ($1,$2,$3,$4,$5) RETURNING *`, [clientId, manual?.requestId ?? null, trigger, p.revision, manual?.operator.id ?? null]);
    await c.query('UPDATE worker_policies SET next_due_at = $2, last_slot = $3 WHERE client_id = $1',
      [clientId, nextDue(p, now, slot ?? p.last_slot), slot ?? p.last_slot]);
    await c.query(
      `INSERT INTO usage_daily (day,provider,metric,qty) VALUES ((now() AT TIME ZONE 'UTC')::date,'worker',$1,1)
       ON CONFLICT (day,provider,metric) DO UPDATE SET qty = usage_daily.qty + 1`, [`client:${clientId}:${trigger}`]);
    await c.query(
      `INSERT INTO audit_log (operator_id,actor,action,target,client_id,status,metadata)
       VALUES ($1,$2,'worker_run_started',$3,$4,202,$5)`,
      [manual?.operator.id ?? null, manual?.operator.email ?? 'worker', run.id, clientId, { trigger, policy_revision: p.revision }]);
    return { run, replay: false };
  });
  if (!claim || claim.replay) return claim?.run ?? null;
  const results: Record<string, Record<string, string>> = {};
  const errors: string[] = [];
  try {
    const { rows: allowed } = await pool.query(
      `SELECT DISTINCT a.network FROM client_assets ca JOIN assets a ON a.id = ca.asset_id
        WHERE ca.client_id = $1 AND a.active`, [clientId]);
    const enabled = new Set(allowed.map((a) => a.network));
    const selected = networks.filter((n) => enabled.has(n.id));
    if (!selected.length) throw new LedgerError(409, 'Cliente sin redes habilitadas en esta instalación', 'no_enabled_networks');
    for (const n of selected) {
      const phases: Record<string, string> = {};
      results[n.id] = phases;
      if (!n.healthy) {
        phases.network = `error: ${n.error ?? 'red fuera de servicio'}`;
        errors.push(`${n.id}: ${phases.network}`);
        continue;
      }
      // No se ejecuta mantenimiento global aquí: un botón de cliente no debe tocar a otro cliente.
      for (const [phase, work] of [
        ['sign', () => signReserved(n, log, clientId)],
        ['webhook', () => registerPendingAddresses(n, log, clientId)],
        ['sweep', () => sweepStep(n, log, clientId)],
      ] as const) {
        try { phases[phase] = await work() ?? 'ok'; }
        catch (e) {
          phases[phase] = `error: ${message(e)}`;
          errors.push(`${n.id}/${phase}: ${message(e)}`);
          log.error({ client_id: clientId, network: n.id, phase, err: message(e) }, 'error en ejecución de cliente');
        }
      }
    }
  } catch (e) {
    errors.push(message(e));
    log.error({ client_id: clientId, err: message(e) }, 'error en ejecución de cliente');
  }
  return tx(async (c) => {
    const { rows: [run] } = await c.query(
      `UPDATE worker_runs SET finished_at = now(), status = $2, networks = $3, error = $4 WHERE id = $1 RETURNING *`,
      [claim.run.id, errors.length ? 'error' : 'ok', results, errors.length ? errors.join('; ').slice(0, 4000) : null]);
    const { rows: [policy] } = await c.query<PolicyRow>('SELECT * FROM worker_policies WHERE client_id = $1', [clientId]);
    const now = (await c.query('SELECT now() AS now')).rows[0].now as Date;
    await c.query('UPDATE worker_policies SET next_due_at = $2 WHERE client_id = $1',
      [clientId, nextDue(policy, now, policy.last_slot)]);
    await c.query(
      `INSERT INTO audit_log (operator_id,actor,action,target,client_id,status,metadata)
       VALUES ($1,$2,'worker_run_finished',$3,$4,$5,$6)`,
      [manual?.operator.id ?? null, manual?.operator.email ?? 'worker', run.id, clientId, errors.length ? 500 : 200,
        { status: run.status, networks: results, error: run.error }]);
    return run;
  });
}

export async function runWorkerClient(clientId: string, requestId: string, operator: Operator, log: Logger) {
  await assertWorkerEnabled();
  return locked(async () => {
    await assertWorkerEnabled();
    await recoverInterrupted();
    return executeClient(clientId, log, { operator, requestId });
  });
}

export async function workerTick(log: Logger) {
  await assertWorkerEnabled();
  return locked(async () => {
    await assertWorkerEnabled();
    await recoverInterrupted();
    const maintenance: Record<string, string> = {};
    for (const n of activeNetworks()) {
      const errors: string[] = [];
      // Cada conciliación se intenta aunque otra falle; nunca queda supeditada a una política local.
      for (const work of [
        () => broadcastSigned(n, log), () => confirmBroadcast(n, log), () => bumpStuck(n, log),
        () => creditConfirmedDeposits(n, log), () => maintainSweeps(n, log),
        () => registerPendingAddresses(n, log, null),
        () => sweepStep(n, log, null),
      ]) {
        try { await work(); }
        catch (e) { errors.push(message(e)); log.error({ network: n.id, err: message(e) }, 'error de mantenimiento'); }
      }
      n.error = errors.length ? errors.join('; ').slice(0, 200) : null;
      maintenance[n.id] = n.error ?? 'ok';
    }
    try { await expirePending(); } catch (e) { log.error({ err: message(e) }, 'error al vencer obligaciones'); }
    try { await fiatTick(log); } catch (e) { log.error({ err: message(e) }, 'error de conciliación fiat'); }
    const { rows: due } = await pool.query(
      `SELECT p.client_id FROM worker_policies p JOIN clients c ON c.id = p.client_id
        WHERE p.mode <> 'manual' AND p.next_due_at <= now() AND c.status = 'active'
        ORDER BY p.next_due_at, p.client_id LIMIT 100`);
    for (const p of due) {
      try { await executeClient(p.client_id, log); }
      catch (e) { log.error({ client_id: p.client_id, err: message(e) }, 'error al reclamar ejecución'); }
    }
    return { maintenance };
  });
}

export function startWorker(log: Logger) {
  const t = setInterval(() => {
    workerTick(log).catch((e) => {
      if (e instanceof LedgerError && ['worker_busy', 'setup_required'].includes(e.code)) return;
      log.error({ err: message(e) }, 'error en worker');
    });
  }, config.WORKER_INTERVAL_MS);
  t.unref();
  return () => clearInterval(t);
}
