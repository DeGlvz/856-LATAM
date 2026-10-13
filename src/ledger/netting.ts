import { pool, tx, type Tx } from '../db.js';
import { decodeCursor, page } from '../pagination.js';
import { LedgerError, openClientAccount, postEntryIn } from './service.js';

// Un pagador neto con este estado no puede disponer de saldo (trigger de la migración 007)
const BLOCKED = new Set(['suspended', 'closed']);

// ───────────── Obligaciones ─────────────
export async function createObligation(o: {
  debtor_id: string; creditor_id: string; asset_id: string; amount: string;
  due_at?: string; external_ref?: string; metadata?: Record<string, unknown>;
}) {
  if (o.debtor_id === o.creditor_id) throw new LedgerError(422, 'Deudor y acreedor deben ser distintos', 'invalid_obligation');
  const { rows: parties } = await pool.query<{ id: string; status: string }>(
    'SELECT id, status FROM clients WHERE id = ANY($1)', [[o.debtor_id, o.creditor_id]]);
  if (parties.length < 2) throw new LedgerError(404, 'Deudor o acreedor inexistente', 'not_found');
  if (parties.some((p) => p.status === 'closed')) {
    throw new LedgerError(409, 'Cliente cerrado: no admite nuevas obligaciones', 'client_closed');
  }
  const { rows } = await pool.query(
    `INSERT INTO obligations (debtor_id, creditor_id, asset_id, amount, due_at, external_ref, metadata)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
    [o.debtor_id, o.creditor_id, o.asset_id, o.amount, o.due_at ?? null, o.external_ref ?? null, o.metadata ?? {}],
  );
  return rows[0];
}

export interface ObligationFilter {
  client_id?: string; status?: string; asset_id?: string; external_ref?: string;
  from?: string; to?: string; netting_run_id?: string; limit?: number; cursor?: string;
}

export async function listObligations(f: ObligationFilter) {
  const limit = Math.min(Math.max(f.limit ?? 100, 1), 1000);
  const cur = decodeCursor(f.cursor);
  const { rows } = await pool.query(
    `SELECT o.*, o.created_at::text AS _ts, d.name AS debtor_name, d.status AS debtor_status,
            c.name AS creditor_name, c.status AS creditor_status
       FROM obligations o JOIN clients d ON d.id = o.debtor_id JOIN clients c ON c.id = o.creditor_id
      WHERE ($1::uuid IS NULL OR o.debtor_id = $1 OR o.creditor_id = $1)
        AND ($2::text IS NULL OR o.status = $2) AND ($3::text IS NULL OR o.asset_id = $3)
        AND ($4::text IS NULL OR o.external_ref ILIKE '%' || $4 || '%')
        AND ($5::timestamptz IS NULL OR o.created_at >= $5) AND ($6::timestamptz IS NULL OR o.created_at < $6)
        AND ($7::uuid IS NULL OR o.netting_run_id = $7)
        AND ($8::timestamptz IS NULL OR (o.created_at, o.id) < ($8::timestamptz, $9::uuid))
      ORDER BY o.created_at DESC, o.id DESC LIMIT $10`,
    [f.client_id ?? null, f.status ?? null, f.asset_id ?? null, f.external_ref ?? null, f.from ?? null, f.to ?? null,
      f.netting_run_id ?? null, cur?.[0] ?? null, cur?.[1] ?? null, limit + 1],
  );
  const p = page(rows, limit);
  return { obligations: p.items, next_cursor: p.next_cursor };
}

export async function cancelObligation(id: string, reason: string, by: string) {
  const { rows } = await pool.query(
    `UPDATE obligations SET status = 'cancelled', cancel_reason = $2, cancelled_at = now(), cancelled_by = $3
      WHERE id = $1 AND status = 'open' RETURNING *`, [id, reason.trim(), by],
  );
  if (!rows[0]) throw new LedgerError(409, 'La obligación no existe o ya no está abierta', 'not_open');
  return rows[0];
}

// ───────────── Motor de compensación ─────────────
export interface NettingScope { asset_id: string; cutoff?: string; obligation_ids?: string[] }

interface Position {
  client_id: string; client_name: string; client_status: string;
  receivable: bigint; payable: bigint; net: bigint; available: bigint;
}
type Obl = { id: string; debtor_id: string; creditor_id: string; amount: string };

async function selectOpen(c: Tx | typeof pool, s: NettingScope, lock: boolean): Promise<Obl[]> {
  const { rows } = await c.query<Obl>(
    `SELECT id, debtor_id, creditor_id, amount FROM obligations
      WHERE status = 'open' AND asset_id = $1
        AND ($2::timestamptz IS NULL OR due_at IS NULL OR due_at <= $2)
        AND ($3::uuid[] IS NULL OR id = ANY($3))
      ORDER BY id ${lock ? 'FOR UPDATE' : ''}`,
    [s.asset_id, s.cutoff ?? null, s.obligation_ids ?? null],
  );
  // Alcance explícito: todas las obligaciones pedidas deben seguir abiertas y dentro del alcance; nunca se ignoran en silencio
  if (s.obligation_ids) {
    const found = new Set(rows.map((r) => r.id));
    const missing = [...new Set(s.obligation_ids)].filter((id) => !found.has(id));
    if (missing.length) {
      throw new LedgerError(422,
        `${missing.length} obligación(es) ya no están abiertas o no corresponden al activo/corte: ${missing.slice(0, 5).join(', ')}${missing.length > 5 ? '…' : ''}`,
        'obligations_not_open');
    }
  }
  return rows;
}

// Posición neta multilateral: cada cliente solo paga o recibe su diferencia
async function computePositions(c: Tx | typeof pool, assetId: string, obs: Obl[]) {
  const pos = new Map<string, Position>();
  const get = (id: string) => pos.get(id) ?? pos.set(id, {
    client_id: id, client_name: '', client_status: '', receivable: 0n, payable: 0n, net: 0n, available: 0n }).get(id)!;
  let gross = 0n;
  for (const o of obs) {
    const amt = BigInt(o.amount);
    gross += amt;
    get(o.creditor_id).receivable += amt;
    get(o.debtor_id).payable += amt;
  }
  const ids = [...pos.keys()];
  if (ids.length) {
    const { rows: cl } = await c.query<{ id: string; name: string; status: string }>(
      'SELECT id, name, status FROM clients WHERE id = ANY($1)', [ids]);
    for (const r of cl) Object.assign(pos.get(r.id)!, { client_name: r.name, client_status: r.status });
    const { rows } = await c.query<{ client_id: string; balance: string }>(
      `SELECT client_id, balance FROM accounts WHERE client_id = ANY($1) AND asset_id = $2 AND type = 'liability'`,
      [ids, assetId],
    );
    for (const r of rows) pos.get(r.client_id)!.available = BigInt(r.balance);
  }
  let net = 0n;
  for (const p of pos.values()) {
    p.net = p.receivable - p.payable;
    if (p.net > 0n) net += p.net;
  }
  return { positions: [...pos.values()].sort((a, b) => (a.client_id < b.client_id ? -1 : 1)), gross, net };
}

const isBlocked = (p: Position) => p.net < 0n && BLOCKED.has(p.client_status);

const view = (r: Awaited<ReturnType<typeof computePositions>>, obs: Obl[]) => ({
  obligations: obs.length,
  obligation_ids: obs.map((o) => o.id),
  participants: r.positions.length,
  gross_amount: r.gross.toString(),
  net_amount: r.net.toString(),
  // Eficiencia: qué fracción del bruto NO tuvo que moverse
  savings_bps: r.gross > 0n ? Number(((r.gross - r.net) * 10000n) / r.gross) : 0,
  positions: r.positions.map((p) => ({
    client_id: p.client_id, client_name: p.client_name, client_status: p.client_status,
    receivable: p.receivable.toString(), payable: p.payable.toString(), net: p.net.toString(),
    available: p.available.toString(), shortfall: p.net < 0n && p.available < -p.net ? (-p.net - p.available).toString() : '0',
    blocked: isBlocked(p),
  })),
});

export async function previewNetting(s: NettingScope) {
  const obs = await selectOpen(pool, s, false);
  const r = await computePositions(pool, s.asset_id, obs);
  const v = view(r, obs);
  const blockers = v.positions.filter((p) => p.blocked).map((p) => p.client_id);
  return {
    ...v,
    blocked_clients: blockers,
    can_settle: obs.length > 0 && blockers.length === 0 && v.positions.every((p) => p.shortfall === '0'),
  };
}

type Computed = Awaited<ReturnType<typeof computePositions>>;

/** Recalcula el alcance y aplica las guardas: neto esperado (deriva), pagadores bloqueados. */
async function evaluate(c: Tx, s: NettingScope, expected?: string) {
  const obs = await selectOpen(c, s, true);
  if (!obs.length) throw new LedgerError(422, 'No hay obligaciones abiertas en el alcance', 'nothing_to_net');
  const r = await computePositions(c, s.asset_id, obs);
  if (expected !== undefined && r.net.toString() !== expected) {
    throw new LedgerError(409,
      `El alcance cambió desde la simulación (neto esperado ${expected}, actual ${r.net}); vuelva a simular`, 'scope_changed');
  }
  const blocked = r.positions.filter(isBlocked);
  if (blocked.length) {
    throw new LedgerError(422,
      `Pagador(es) neto(s) suspendido(s) o cerrado(s): ${blocked.map((p) => p.client_name || p.client_id).join(', ')}. Excluya sus obligaciones o reactívelos`,
      'client_not_active');
  }
  return { obs, r };
}

/** Un solo asiento: pagadores netos se debitan, receptores netos se acreditan; obligaciones quedan liquidadas. */
async function settleRun(c: Tx, runId: string, assetId: string, obs: Obl[], r: Computed) {
  const postings = [];
  for (const p of r.positions) {
    if (p.net === 0n) continue;
    const acc = await openClientAccount(c, p.client_id, assetId);
    postings.push({
      account: acc.id as string,
      direction: (p.net < 0n ? 'debit' : 'credit') as 'debit' | 'credit', // pasivo: débito = baja saldo
      amount: (p.net < 0n ? -p.net : p.net).toString(),
    });
  }
  if (postings.length) {
    const e = await postEntryIn(c, {
      kind: 'netting', description: `Compensación multilateral ${assetId}`, external_ref: `netting:${runId}`,
      idempotency_key: `netting:${runId}`, metadata: { netting_run_id: runId, obligations: obs.length },
      postings,
    });
    await c.query('UPDATE netting_runs SET entry_id = $2 WHERE id = $1', [runId, e.id]);
  }
  for (const p of r.positions) {
    await c.query(
      'INSERT INTO netting_positions (run_id, client_id, receivable, payable, net) VALUES ($1,$2,$3,$4,$5)',
      [runId, p.client_id, p.receivable.toString(), p.payable.toString(), p.net.toString()],
    );
  }
  await c.query(
    `UPDATE obligations SET status = 'settled', netting_run_id = $1, settled_at = now() WHERE id = ANY($2)`,
    [runId, obs.map((o) => o.id)],
  );
}

const pgToLedger = (e: unknown) => {
  const err = e as { code?: string };
  if (err.code === '23514') {
    return new LedgerError(422, 'Saldo insuficiente de al menos un pagador neto; consulte /v1/netting/preview', 'insufficient_funds');
  }
  return e;
};

/**
 * Sin doble aprobación: liquida en UN asiento atómico. Con doble aprobación: registra la solicitud
 * (pending_approval) con las obligaciones exactas y el neto esperado; se liquida cuando otro tesorero la aprueba.
 * `expected_net_amount` (de la simulación) protege contra cambios del alcance entre simular y confirmar.
 */
export async function runNetting(s: NettingScope & {
  idempotency_key?: string; expected_net_amount?: string; created_by?: string;
  requested_by_operator?: string | null; needs_approval?: boolean;
}) {
  try {
    return await tx(async (c) => {
      if (s.idempotency_key) {
        const prev = await c.query('SELECT id FROM netting_runs WHERE idempotency_key = $1', [s.idempotency_key]);
        if (prev.rows[0]) return { id: prev.rows[0].id as string };
      }
      const { obs, r } = await evaluate(c, s, s.expected_net_amount);
      const pending = !!s.needs_approval;
      if (pending) {
        // Anticipar faltantes: una solicitud que no podría liquidarse no entra a la cola
        const short = r.positions.find((p) => p.net < 0n && p.available < -p.net);
        if (short) throw new LedgerError(422, `Saldo insuficiente de ${short.client_name || short.client_id}; consulte /v1/netting/preview`, 'insufficient_funds');
      }
      const { rows: [run] } = await c.query(
        `INSERT INTO netting_runs (asset_id, status, cutoff, obligations, participants, gross_amount, net_amount, idempotency_key,
                                   created_by, requested_by_operator, scope, expected_net_amount, decided_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id`,
        [s.asset_id, pending ? 'pending_approval' : 'settled', s.cutoff ?? null, obs.length, r.positions.length,
          r.gross.toString(), r.net.toString(), s.idempotency_key ?? null, s.created_by ?? null, s.requested_by_operator ?? null,
          { asset_id: s.asset_id, cutoff: s.cutoff ?? null, obligation_ids: obs.map((o) => o.id) }, r.net.toString(),
          pending ? null : new Date()],
      );
      if (!pending) await settleRun(c, run.id, s.asset_id, obs, r);
      return { id: run.id as string };
    }).then((r) => getNettingRun(r.id));
  } catch (e) {
    const err = e as { code?: string };
    if (err.code === '23505' && s.idempotency_key) {
      const prev = await pool.query('SELECT id FROM netting_runs WHERE idempotency_key = $1', [s.idempotency_key]);
      if (prev.rows[0]) return getNettingRun(prev.rows[0].id);
    }
    throw pgToLedger(e);
  }
}

/** Segundo tesorero: liquida exactamente lo solicitado si nada cambió (mismas obligaciones abiertas, mismo neto). */
export async function approveNettingRun(id: string, by: { email: string; id: string }) {
  try {
    await tx(async (c) => {
      const { rows: [run] } = await c.query('SELECT * FROM netting_runs WHERE id = $1 FOR UPDATE', [id]);
      if (!run) throw new LedgerError(404, 'Corrida de compensación no encontrada', 'not_found');
      if (run.status !== 'pending_approval') throw new LedgerError(409, `La corrida no está pendiente (estado: ${run.status})`, 'not_pending');
      if (run.requested_by_operator === by.id) throw new LedgerError(403, 'Doble aprobación: quien solicitó no puede aprobar', 'same_operator');
      const scope = run.scope as { asset_id: string; cutoff: string | null; obligation_ids: string[] };
      const { obs, r } = await evaluate(c, { asset_id: scope.asset_id, cutoff: scope.cutoff ?? undefined, obligation_ids: scope.obligation_ids },
        String(run.expected_net_amount));
      await c.query(
        `UPDATE netting_runs SET status = 'settled', approved_by = $2, approved_by_operator = $3, decided_at = now(), last_error = NULL
          WHERE id = $1`, [id, by.email, by.id]);
      await settleRun(c, id, scope.asset_id, obs, r);
    });
  } catch (e) {
    const err = pgToLedger(e) as Error & { code?: string };
    // El intento fallido queda visible en la cola (la corrida sigue pendiente)
    if (err instanceof LedgerError && err.code !== 'not_found' && err.code !== 'not_pending' && err.code !== 'same_operator') {
      await pool.query(`UPDATE netting_runs SET last_error = $2 WHERE id = $1 AND status = 'pending_approval'`, [id, err.message.slice(0, 500)]);
    }
    throw err;
  }
  return getNettingRun(id);
}

export async function rejectNettingRun(id: string, by: string, reason: string) {
  const { rows: [run] } = await pool.query(
    `UPDATE netting_runs SET status = 'rejected', rejected_by = $2, rejected_reason = $3, decided_at = now()
      WHERE id = $1 AND status = 'pending_approval' RETURNING id`, [id, by, reason]);
  if (!run) throw new LedgerError(409, 'La corrida no existe o no está pendiente', 'not_pending');
  return getNettingRun(id);
}

export async function listNettingRuns(f: { asset_id?: string; status?: string; limit?: number; cursor?: string }) {
  const limit = Math.min(Math.max(f.limit ?? 50, 1), 200);
  const cur = decodeCursor(f.cursor);
  const { rows } = await pool.query(
    `SELECT id, asset_id, status, cutoff, obligations, participants, gross_amount, net_amount, entry_id, created_by,
            approved_by, rejected_by, rejected_reason, decided_at, last_error, created_at, created_at::text AS _ts,
            CASE WHEN gross_amount > 0 THEN floor((gross_amount - net_amount) * 10000 / gross_amount)::int ELSE 0 END AS savings_bps
       FROM netting_runs
      WHERE ($1::text IS NULL OR asset_id = $1) AND ($5::text IS NULL OR status = $5)
        AND ($2::timestamptz IS NULL OR (created_at, id) < ($2::timestamptz, $3::uuid))
      ORDER BY created_at DESC, id DESC LIMIT $4`,
    [f.asset_id ?? null, cur?.[0] ?? null, cur?.[1] ?? null, limit + 1, f.status ?? null],
  );
  const p = page(rows, limit);
  return { runs: p.items, next_cursor: p.next_cursor };
}

export async function getNettingRun(id: string) {
  const { rows: [run] } = await pool.query('SELECT * FROM netting_runs WHERE id = $1', [id]);
  if (!run) throw new LedgerError(404, 'Corrida de compensación no encontrada', 'not_found');
  const gross = BigInt(run.gross_amount), net = BigInt(run.net_amount);
  const base = { ...run, savings_bps: gross > 0n ? Number(((gross - net) * 10000n) / gross) : 0 };
  if (run.status !== 'settled') {
    // Pendiente o rechazada: obligaciones solicitadas (con su estado actual) y posiciones recalculadas al momento
    const ids: string[] = run.scope?.obligation_ids ?? [];
    const { rows: obligations } = await pool.query(
      `SELECT o.id, o.debtor_id, d.name AS debtor_name, o.creditor_id, c.name AS creditor_name, o.amount, o.external_ref, o.due_at, o.status
         FROM obligations o JOIN clients d ON d.id = o.debtor_id JOIN clients c ON c.id = o.creditor_id
        WHERE o.id = ANY($1) ORDER BY o.id`, [ids]);
    let preview = null;
    if (run.status === 'pending_approval') {
      const open = obligations.filter((o) => o.status === 'open');
      const r = await computePositions(pool, run.asset_id, open as unknown as Obl[]);
      const v = view(r, open as unknown as Obl[]);
      preview = {
        ...v, all_open: open.length === ids.length, net_matches: r.net.toString() === String(run.expected_net_amount),
        can_settle: open.length === ids.length && r.net.toString() === String(run.expected_net_amount)
          && v.positions.every((p) => p.shortfall === '0' && !p.blocked),
      };
    }
    return { ...base, positions: preview?.positions ?? [], obligations, preview };
  }
  const { rows: positions } = await pool.query(
    `SELECT p.client_id, c.name AS client_name, p.receivable, p.payable, p.net
       FROM netting_positions p JOIN clients c ON c.id = p.client_id WHERE p.run_id = $1 ORDER BY p.client_id`, [id],
  );
  const { rows: obligations } = await pool.query(
    `SELECT o.id, o.debtor_id, d.name AS debtor_name, o.creditor_id, c.name AS creditor_name, o.amount, o.external_ref, o.due_at
       FROM obligations o JOIN clients d ON d.id = o.debtor_id JOIN clients c ON c.id = o.creditor_id
      WHERE o.netting_run_id = $1 ORDER BY o.id`, [id],
  );
  return { ...base, positions, obligations, preview: null };
}
