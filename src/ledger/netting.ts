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

/**
 * Liquida en UN asiento atómico: los pagadores netos se debitan, los receptores netos se acreditan,
 * y todas las obligaciones del alcance quedan 'settled'. Si a un pagador no le alcanza, no se mueve nada.
 * `expected_net_amount` (de la simulación) protege contra cambios del alcance entre simular y confirmar.
 */
export async function runNetting(s: NettingScope & { idempotency_key?: string; expected_net_amount?: string; created_by?: string }) {
  try {
    return await tx(async (c) => {
      if (s.idempotency_key) {
        const prev = await c.query('SELECT id FROM netting_runs WHERE idempotency_key = $1', [s.idempotency_key]);
        if (prev.rows[0]) return { id: prev.rows[0].id as string };
      }
      const obs = await selectOpen(c, s, true);
      if (!obs.length) throw new LedgerError(422, 'No hay obligaciones abiertas en el alcance', 'nothing_to_net');
      const r = await computePositions(c, s.asset_id, obs);

      if (s.expected_net_amount !== undefined && r.net.toString() !== s.expected_net_amount) {
        throw new LedgerError(409,
          `El alcance cambió desde la simulación (neto esperado ${s.expected_net_amount}, actual ${r.net}); vuelva a simular`,
          'scope_changed');
      }
      const blocked = r.positions.filter(isBlocked);
      if (blocked.length) {
        throw new LedgerError(422,
          `Pagador(es) neto(s) suspendido(s) o cerrado(s): ${blocked.map((p) => p.client_name || p.client_id).join(', ')}. Excluya sus obligaciones o reactívelos`,
          'client_not_active');
      }

      const postings = [];
      for (const p of r.positions) {
        if (p.net === 0n) continue;
        const acc = await openClientAccount(c, p.client_id, s.asset_id);
        postings.push({
          account: acc.id as string,
          direction: (p.net < 0n ? 'debit' : 'credit') as 'debit' | 'credit', // pasivo: débito = baja saldo
          amount: (p.net < 0n ? -p.net : p.net).toString(),
        });
      }

      const { rows: [run] } = await c.query(
        `INSERT INTO netting_runs (asset_id, status, cutoff, obligations, participants, gross_amount, net_amount, idempotency_key, created_by)
         VALUES ($1,'settled',$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
        [s.asset_id, s.cutoff ?? null, obs.length, r.positions.length, r.gross.toString(), r.net.toString(),
          s.idempotency_key ?? null, s.created_by ?? null],
      );

      let entryId: string | null = null;
      if (postings.length) {
        const e = await postEntryIn(c, {
          kind: 'netting', description: `Compensación multilateral ${s.asset_id}`, external_ref: `netting:${run.id}`,
          idempotency_key: `netting:${run.id}`, metadata: { netting_run_id: run.id, obligations: obs.length },
          postings,
        });
        entryId = e.id;
        await c.query('UPDATE netting_runs SET entry_id = $2 WHERE id = $1', [run.id, entryId]);
      }

      for (const p of r.positions) {
        await c.query(
          'INSERT INTO netting_positions (run_id, client_id, receivable, payable, net) VALUES ($1,$2,$3,$4,$5)',
          [run.id, p.client_id, p.receivable.toString(), p.payable.toString(), p.net.toString()],
        );
      }
      await c.query(
        `UPDATE obligations SET status = 'settled', netting_run_id = $1, settled_at = now() WHERE id = ANY($2)`,
        [run.id, obs.map((o) => o.id)],
      );
      return { id: run.id as string };
    }).then((r) => getNettingRun(r.id));
  } catch (e) {
    const err = e as { code?: string };
    if (err.code === '23514') {
      throw new LedgerError(422, 'Saldo insuficiente de al menos un pagador neto; consulte /v1/netting/preview', 'insufficient_funds');
    }
    if (err.code === '23505' && s.idempotency_key) {
      const prev = await pool.query('SELECT id FROM netting_runs WHERE idempotency_key = $1', [s.idempotency_key]);
      if (prev.rows[0]) return getNettingRun(prev.rows[0].id);
    }
    throw e;
  }
}

export async function listNettingRuns(f: { asset_id?: string; limit?: number; cursor?: string }) {
  const limit = Math.min(Math.max(f.limit ?? 50, 1), 200);
  const cur = decodeCursor(f.cursor);
  const { rows } = await pool.query(
    `SELECT id, asset_id, status, cutoff, obligations, participants, gross_amount, net_amount, entry_id, created_by,
            created_at, created_at::text AS _ts,
            CASE WHEN gross_amount > 0 THEN floor((gross_amount - net_amount) * 10000 / gross_amount)::int ELSE 0 END AS savings_bps
       FROM netting_runs
      WHERE ($1::text IS NULL OR asset_id = $1)
        AND ($2::timestamptz IS NULL OR (created_at, id) < ($2::timestamptz, $3::uuid))
      ORDER BY created_at DESC, id DESC LIMIT $4`,
    [f.asset_id ?? null, cur?.[0] ?? null, cur?.[1] ?? null, limit + 1],
  );
  const p = page(rows, limit);
  return { runs: p.items, next_cursor: p.next_cursor };
}

export async function getNettingRun(id: string) {
  const { rows: [run] } = await pool.query('SELECT * FROM netting_runs WHERE id = $1', [id]);
  if (!run) throw new LedgerError(404, 'Corrida de compensación no encontrada', 'not_found');
  const { rows: positions } = await pool.query(
    `SELECT p.client_id, c.name AS client_name, p.receivable, p.payable, p.net
       FROM netting_positions p JOIN clients c ON c.id = p.client_id WHERE p.run_id = $1 ORDER BY p.client_id`, [id],
  );
  const { rows: obligations } = await pool.query(
    `SELECT o.id, o.debtor_id, d.name AS debtor_name, o.creditor_id, c.name AS creditor_name, o.amount, o.external_ref, o.due_at
       FROM obligations o JOIN clients d ON d.id = o.debtor_id JOIN clients c ON c.id = o.creditor_id
      WHERE o.netting_run_id = $1 ORDER BY o.id`, [id],
  );
  const gross = BigInt(run.gross_amount), net = BigInt(run.net_amount);
  return { ...run, savings_bps: gross > 0n ? Number(((gross - net) * 10000n) / gross) : 0, positions, obligations };
}
