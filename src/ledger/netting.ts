import { pool, tx, type Tx } from '../db.js';
import { LedgerError, openClientAccount, postEntryIn } from './service.js';

// ───────────── Obligaciones ─────────────
export async function createObligation(o: {
  debtor_id: string; creditor_id: string; asset_id: string; amount: string;
  due_at?: string; external_ref?: string; metadata?: Record<string, unknown>;
}) {
  if (o.debtor_id === o.creditor_id) throw new LedgerError(422, 'Deudor y acreedor deben ser distintos', 'invalid_obligation');
  const { rows } = await pool.query(
    `INSERT INTO obligations (debtor_id, creditor_id, asset_id, amount, due_at, external_ref, metadata)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
    [o.debtor_id, o.creditor_id, o.asset_id, o.amount, o.due_at ?? null, o.external_ref ?? null, o.metadata ?? {}],
  );
  return rows[0];
}

export async function listObligations(f: { client_id?: string; status?: string; asset_id?: string; limit?: number }) {
  const { rows } = await pool.query(
    `SELECT * FROM obligations
      WHERE ($1::uuid IS NULL OR debtor_id = $1 OR creditor_id = $1)
        AND ($2::text IS NULL OR status = $2) AND ($3::text IS NULL OR asset_id = $3)
      ORDER BY created_at DESC LIMIT $4`,
    [f.client_id ?? null, f.status ?? null, f.asset_id ?? null, Math.min(f.limit ?? 100, 1000)],
  );
  return rows;
}

export async function cancelObligation(id: string) {
  const { rows } = await pool.query(
    `UPDATE obligations SET status = 'cancelled' WHERE id = $1 AND status = 'open' RETURNING *`, [id],
  );
  if (!rows[0]) throw new LedgerError(409, 'La obligación no existe o ya no está abierta', 'not_open');
  return rows[0];
}

// ───────────── Motor de compensación ─────────────
export interface NettingScope { asset_id: string; cutoff?: string; obligation_ids?: string[] }

interface Position { client_id: string; receivable: bigint; payable: bigint; net: bigint; available: bigint }

async function selectOpen(c: Tx | typeof pool, s: NettingScope, lock: boolean) {
  const { rows } = await c.query<{ id: string; debtor_id: string; creditor_id: string; amount: string }>(
    `SELECT id, debtor_id, creditor_id, amount FROM obligations
      WHERE status = 'open' AND asset_id = $1
        AND ($2::timestamptz IS NULL OR due_at IS NULL OR due_at <= $2)
        AND ($3::uuid[] IS NULL OR id = ANY($3))
      ORDER BY id ${lock ? 'FOR UPDATE' : ''}`,
    [s.asset_id, s.cutoff ?? null, s.obligation_ids ?? null],
  );
  return rows;
}

// Posición neta multilateral: cada cliente solo paga o recibe su diferencia
async function computePositions(c: Tx | typeof pool, assetId: string, obs: Awaited<ReturnType<typeof selectOpen>>) {
  const pos = new Map<string, Position>();
  const get = (id: string) => pos.get(id) ?? pos.set(id, { client_id: id, receivable: 0n, payable: 0n, net: 0n, available: 0n }).get(id)!;
  let gross = 0n;
  for (const o of obs) {
    const amt = BigInt(o.amount);
    gross += amt;
    get(o.creditor_id).receivable += amt;
    get(o.debtor_id).payable += amt;
  }
  const ids = [...pos.keys()];
  if (ids.length) {
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

const view = (r: Awaited<ReturnType<typeof computePositions>>, count: number) => ({
  obligations: count,
  participants: r.positions.length,
  gross_amount: r.gross.toString(),
  net_amount: r.net.toString(),
  // Eficiencia: qué fracción del bruto NO tuvo que moverse
  savings_bps: r.gross > 0n ? Number(((r.gross - r.net) * 10000n) / r.gross) : 0,
  positions: r.positions.map((p) => ({
    client_id: p.client_id, receivable: p.receivable.toString(), payable: p.payable.toString(), net: p.net.toString(),
    available: p.available.toString(), shortfall: p.net < 0n && p.available < -p.net ? (-p.net - p.available).toString() : '0',
  })),
});

export async function previewNetting(s: NettingScope) {
  const obs = await selectOpen(pool, s, false);
  const r = await computePositions(pool, s.asset_id, obs);
  const v = view(r, obs.length);
  return { ...v, can_settle: obs.length > 0 && v.positions.every((p) => p.shortfall === '0') };
}

/**
 * Liquida en UN asiento atómico: los pagadores netos se debitan, los receptores netos se acreditan,
 * y todas las obligaciones del alcance quedan 'settled'. Si a un pagador no le alcanza, no se mueve nada.
 */
export async function runNetting(s: NettingScope & { idempotency_key?: string }) {
  try {
    return await tx(async (c) => {
      if (s.idempotency_key) {
        const prev = await c.query('SELECT id FROM netting_runs WHERE idempotency_key = $1', [s.idempotency_key]);
        if (prev.rows[0]) return { id: prev.rows[0].id as string };
      }
      const obs = await selectOpen(c, s, true);
      if (!obs.length) throw new LedgerError(422, 'No hay obligaciones abiertas en el alcance', 'nothing_to_net');
      const r = await computePositions(c, s.asset_id, obs);

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
        `INSERT INTO netting_runs (asset_id, status, cutoff, obligations, participants, gross_amount, net_amount, idempotency_key)
         VALUES ($1,'settled',$2,$3,$4,$5,$6,$7) RETURNING id`,
        [s.asset_id, s.cutoff ?? null, obs.length, r.positions.length, r.gross.toString(), r.net.toString(), s.idempotency_key ?? null],
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

export async function getNettingRun(id: string) {
  const { rows: [run] } = await pool.query('SELECT * FROM netting_runs WHERE id = $1', [id]);
  if (!run) throw new LedgerError(404, 'Corrida de compensación no encontrada', 'not_found');
  const { rows: positions } = await pool.query(
    'SELECT client_id, receivable, payable, net FROM netting_positions WHERE run_id = $1 ORDER BY client_id', [id],
  );
  const { rows: obligations } = await pool.query(
    'SELECT id, debtor_id, creditor_id, amount, external_ref FROM obligations WHERE netting_run_id = $1 ORDER BY id', [id],
  );
  const gross = BigInt(run.gross_amount), net = BigInt(run.net_amount);
  return { ...run, savings_bps: gross > 0n ? Number(((gross - net) * 10000n) / gross) : 0, positions, obligations };
}
