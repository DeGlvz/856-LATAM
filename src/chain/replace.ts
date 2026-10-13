// Reemplazo de transacciones atascadas ("gas bump"): se vuelve a firmar el MISMO nonce con comisiones más altas.
// Todos los intentos quedan en tx_attempts; la confirmación acepta el recibo de cualquiera de ellos.
import { keccak256, parseTransaction, type Address, type Hash, type Hex, type TransactionReceipt } from 'viem';
import { client } from '../chain.js';
import { config } from '../config.js';
import { pool, type Tx } from '../db.js';
import { LedgerError } from '../ledger/service.js';
import { getDepositKeyring, getSigner, type Signer } from './signer.js';

export type TxKind = 'withdrawal' | 'sweep';
type Log = { info: (o: object, m: string) => void; warn: (o: object, m: string) => void };
const TABLE: Record<TxKind, 'withdrawals' | 'sweeps'> = { withdrawal: 'withdrawals', sweep: 'sweeps' };
const WORKER_LOCK = 856003; // el mismo candado del worker: nunca se firman dos cosas a la vez

const feesOf = (raw: string) => {
  const t = parseTransaction(raw as Hex);
  if (t.type !== 'eip1559' || t.maxFeePerGas == null || t.maxPriorityFeePerGas == null) {
    throw new LedgerError(422, 'Solo se pueden acelerar transacciones EIP-1559', 'not_eip1559');
  }
  return { t, maxFee: t.maxFeePerGas, prio: t.maxPriorityFeePerGas };
};

/** Registra el primer envío (se llama al firmar). Idempotente. */
export async function recordOriginal(c: Tx | typeof pool, kind: TxKind, refId: string, from: string, nonce: number | string, raw: string) {
  const { maxFee, prio } = feesOf(raw);
  await c.query(
    `INSERT INTO tx_attempts (kind, ref_id, from_address, nonce, tx_hash, raw_tx, max_fee_per_gas, max_priority_fee_per_gas, reason)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'original') ON CONFLICT (tx_hash) DO NOTHING`,
    [kind, refId, from, nonce, keccak256(raw as Hex), raw, maxFee.toString(), prio.toString()]);
}

/** Recibo del hash vigente o, si no lo hay, de cualquier intento anterior con el mismo nonce. */
export async function findReceipt(kind: TxKind, refId: string, current: string): Promise<{ receipt: TransactionReceipt; hash: string } | null> {
  const r = await client.getTransactionReceipt({ hash: current as Hash }).catch(() => null);
  if (r) return { receipt: r, hash: current };
  const { rows } = await pool.query(
    'SELECT tx_hash FROM tx_attempts WHERE kind = $1 AND ref_id = $2 AND tx_hash <> $3 ORDER BY created_at DESC', [kind, refId, current]);
  for (const a of rows) {
    const rr = await client.getTransactionReceipt({ hash: a.tx_hash as Hash }).catch(() => null);
    if (rr) return { receipt: rr, hash: a.tx_hash };
  }
  return null;
}

async function signerFor(kind: TxKind, row: { from_address: string; wallet_id?: string }): Promise<Signer> {
  const hot = getSigner();
  if (hot && hot.address().toLowerCase() === row.from_address) return hot;
  if (kind === 'sweep' && row.wallet_id) {
    const { rows: [w] } = await pool.query('SELECT derivation_index FROM wallets WHERE id = $1', [row.wallet_id]);
    const s = w?.derivation_index != null ? getDepositKeyring()?.derive(w.derivation_index) : undefined;
    if (s && s.address().toLowerCase() === row.from_address) return s;
  }
  throw new LedgerError(503, 'No hay firmante disponible para la dirección de origen', 'no_signer');
}

const up = (v: bigint) => (v * BigInt(100 + config.GAS_BUMP_PERCENT) + 99n) / 100n; // redondeo hacia arriba

/**
 * Acelera una transacción enviada y no minada. Debe llamarse con el candado del worker tomado.
 * Errores: not_broadcast, already_mined (409); bump_limit, gas_cap, bump_rejected (422).
 */
export async function bumpLocked(kind: TxKind, id: string, opts: { manual?: string; log?: Log } = {}) {
  const table = TABLE[kind];
  const { rows: [row] } = await pool.query(`SELECT * FROM ${table} WHERE id = $1`, [id]);
  if (!row) throw new LedgerError(404, 'No encontrado', 'not_found');
  if (row.status !== 'broadcast') throw new LedgerError(409, `Solo se acelera lo enviado y no confirmado (estado: ${row.status})`, 'not_broadcast');
  const latest = await client.getTransactionCount({ address: row.from_address as Address, blockTag: 'latest' });
  if (latest > Number(row.nonce)) {
    throw new LedgerError(409, 'Ya se minó una transacción con ese nonce; se confirmará en el siguiente ciclo', 'already_mined');
  }
  if (row.bumps >= config.GAS_BUMP_MAX_ATTEMPTS) {
    throw new LedgerError(422, `Se alcanzó el máximo de ${config.GAS_BUMP_MAX_ATTEMPTS} aceleraciones`, 'bump_limit');
  }

  const { t, maxFee, prio } = feesOf(row.raw_tx);
  const est = await client.estimateFeesPerGas();
  const newPrio = up(prio) > est.maxPriorityFeePerGas ? up(prio) : est.maxPriorityFeePerGas;
  let newMax = up(maxFee) > est.maxFeePerGas ? up(maxFee) : est.maxFeePerGas;
  if (newMax < newPrio) newMax = newPrio;
  if (newMax > config.GAS_BUMP_MAX_FEE_WEI) {
    const msg = `Gas bump detenido: la comisión necesaria (${newMax} wei) supera el tope GAS_BUMP_MAX_FEE_WEI (${config.GAS_BUMP_MAX_FEE_WEI})`;
    await pool.query(`UPDATE ${table} SET last_error = $2, updated_at = now() WHERE id = $1`, [id, msg]);
    throw new LedgerError(422, msg, 'gas_cap');
  }

  const signer = await signerFor(kind, row);
  const raw = await signer.signTransaction({
    type: 'eip1559', chainId: t.chainId!, nonce: Number(row.nonce), gas: t.gas!, to: t.to!, value: t.value ?? 0n, data: t.data,
    maxFeePerGas: newMax, maxPriorityFeePerGas: newPrio,
  });
  const hash = keccak256(raw);

  // Primero se registra el intento (si el proceso cae tras enviar, la confirmación igual lo encuentra)
  await recordOriginal(pool, kind, id, row.from_address, row.nonce, row.raw_tx);
  const { rows: [att] } = await pool.query(
    `INSERT INTO tx_attempts (kind, ref_id, from_address, nonce, tx_hash, raw_tx, max_fee_per_gas, max_priority_fee_per_gas, reason, requested_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
    [kind, id, row.from_address, row.nonce, hash, raw, newMax.toString(), newPrio.toString(), opts.manual ? 'manual' : 'bump', opts.manual ?? null]);

  try {
    await client.sendRawTransaction({ serializedTransaction: raw });
  } catch (e) {
    const msg = (e as Error).message.split('\n')[0].slice(0, 500);
    if (!/already known|known transaction/i.test(msg)) {
      await pool.query('UPDATE tx_attempts SET error = $2 WHERE id = $1', [att.id, msg]);
      if (/nonce too low/i.test(msg)) throw new LedgerError(409, 'Ya se minó una transacción con ese nonce', 'already_mined');
      await pool.query(`UPDATE ${table} SET last_error = $2, updated_at = now() WHERE id = $1`, [id, `Gas bump rechazado: ${msg}`]);
      throw new LedgerError(422, `La red rechazó el reemplazo: ${msg}`, 'bump_rejected');
    }
  }
  await pool.query('UPDATE tx_attempts SET sent_at = now() WHERE id = $1', [att.id]);
  await pool.query(
    `UPDATE ${table} SET tx_hash = $2, raw_tx = $3, bumps = bumps + 1, broadcast_at = now(), last_error = NULL, updated_at = now() WHERE id = $1`,
    [id, hash, raw]);
  opts.log?.info({ [kind]: id, tx: hash, max_fee: newMax.toString(), prio: newPrio.toString() }, 'transacción acelerada (gas bump)');
  return { tx_hash: hash, max_fee_per_gas: newMax.toString(), max_priority_fee_per_gas: newPrio.toString(), previous_max_fee_per_gas: maxFee.toString() };
}

/** Paso del worker: acelera lo enviado que lleva más de GAS_BUMP_AFTER_SEC sin minarse. */
export async function bumpStuck(log: Log) {
  if (!config.GAS_BUMP_ENABLED) return;
  for (const kind of ['withdrawal', 'sweep'] as const) {
    const { rows } = await pool.query(
      `SELECT id FROM ${TABLE[kind]} WHERE status = 'broadcast' AND bumps < $1
          AND COALESCE(broadcast_at, updated_at) < now() - make_interval(secs => $2)
        ORDER BY nonce`, [config.GAS_BUMP_MAX_ATTEMPTS, config.GAS_BUMP_AFTER_SEC]);
    for (const r of rows) {
      try { await bumpLocked(kind, r.id, { log }); } catch (e) {
        const err = e as LedgerError;
        if (err.code !== 'already_mined') log.warn({ [kind]: r.id, err: err.message }, 'no se pudo acelerar');
      }
    }
  }
}

/** Aceleración manual desde la consola: toma el candado del worker para no chocar con un ciclo en curso. */
export async function bumpNow(kind: TxKind, id: string, by: string, log?: Log) {
  const c = await pool.connect();
  try {
    const { rows: [l] } = await c.query('SELECT pg_try_advisory_lock($1) AS ok', [WORKER_LOCK]);
    if (!l.ok) throw new LedgerError(409, 'El worker está procesando un ciclo; intente de nuevo en unos segundos', 'worker_busy');
    try { return await bumpLocked(kind, id, { manual: by, log }); } finally { await c.query('SELECT pg_advisory_unlock($1)', [WORKER_LOCK]); }
  } finally { c.release(); }
}

export async function listAttempts(kind: TxKind, refId: string) {
  const { rows } = await pool.query(
    `SELECT tx_hash, max_fee_per_gas, max_priority_fee_per_gas, reason, requested_by, sent_at, error, created_at
       FROM tx_attempts WHERE kind = $1 AND ref_id = $2 ORDER BY created_at`, [kind, refId]);
  return rows;
}
