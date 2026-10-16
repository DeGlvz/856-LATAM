// Registro de gas en el libro: cada fondeo de la hot wallet (moneda nativa) entra como aportación de 856
// (cargo custodia nativa / abono patrimonio). Sin él, el gas de barridos y retiros no se puede registrar
// (la custodia nativa del libro quedaría negativa) y esos movimientos se quedan sin liquidar.
// El registro se ata a una transacción verificable: el monto sale de la cadena, nunca se captura.
import type { Hash } from 'viem';
import { getSigner } from '../chain/signer.js';
import { net, networks } from '../chain/networks.js';
import { pool, tx } from '../db.js';
import { HttpError } from '../idempotency.js';
import { postEntryIn } from './service.js';

const lower = (a: string) => a.toLowerCase();
/** Prefijos de los mensajes con que el worker marca un barrido o retiro que no pudo registrar su gas. */
export const STUCK_SWEEP_MSG = 'Custodia nativa insuficiente en libro';
export const STUCK_WD_MSG = 'Custodia insuficiente para registrar';

async function nativeOf(network: string) {
  const { rows: [a] } = await pool.query(`SELECT id, decimals FROM assets WHERE network = $1 AND kind = 'native' AND active`, [network]);
  if (!a) throw new HttpError(422, `La red ${network} no tiene activo nativo activo`, 'native_missing');
  return a as { id: string; decimals: number };
}

/**
 * Registra el fondeo de gas de la transacción `txHash` en la red `network`. Verifica en cadena:
 *  • transacción exitosa y con las confirmaciones de la red
 *  • destino = hot wallet de 856, envío en moneda nativa (value > 0)
 *  • origen ajeno a la plataforma (no la propia hot wallet ni una dirección de depósito o tesorería de 856)
 * Idempotente por red + hash: un segundo registro responde 409.
 */
export async function registerGasFunding(network: string, txHash: string, by: string) {
  if (!/^0x[0-9a-fA-F]{64}$/.test(txHash)) throw new HttpError(400, 'Hash inválido', 'invalid_hash');
  const n = net(network);
  const hot = getSigner();
  if (!hot) throw new HttpError(503, 'Sin hot wallet configurada', 'signer_missing');
  const hash = lower(txHash) as Hash;
  const key = `gas-funding:${n.id}:${hash}`;
  const { rows: [prev] } = await pool.query('SELECT id FROM journal_entries WHERE idempotency_key = $1', [key]);
  if (prev) throw new HttpError(409, 'Ese fondeo ya está registrado', 'already_registered');

  const [receipt, txn] = await Promise.all([
    n.client.getTransactionReceipt({ hash }).catch(() => null),
    n.client.getTransaction({ hash }).catch(() => null),
  ]);
  if (!receipt || !txn) throw new HttpError(404, `Transacción no encontrada en ${n.label}`, 'tx_not_found');
  if (receipt.status !== 'success') throw new HttpError(422, 'La transacción revirtió', 'tx_reverted');
  const head = await n.client.getBlockNumber({ cacheTime: 0 });
  const confs = Number(head - receipt.blockNumber + 1n);
  if (confs < n.confirmations) {
    throw new HttpError(422, `Faltan confirmaciones: ${confs} de ${n.confirmations}; intente en unos minutos`, 'not_confirmed');
  }
  const hotAddr = lower(hot.address());
  if (!txn.to || lower(txn.to) !== hotAddr) throw new HttpError(422, 'El destino de la transacción no es la hot wallet de 856', 'not_to_hot_wallet');
  if (txn.value <= 0n) throw new HttpError(422, 'La transacción no envía moneda nativa', 'no_native_value');
  const from = lower(txn.from);
  const { rows: [own] } = await pool.query(
    `SELECT purpose FROM wallets WHERE network = $1 AND address = $2 AND purpose IN ('master_hot','master_cold','deposit','fiat_treasury') LIMIT 1`,
    [n.id, from]);
  if (from === hotAddr || own) {
    throw new HttpError(422, 'El origen es una dirección de la plataforma: es un movimiento interno, no un fondeo', 'internal_transfer');
  }

  const native = await nativeOf(n.id);
  const entryId = await tx(async (c) => {
    const e = await postEntryIn(c, {
      kind: 'gas_funding', description: `Aportación de gas a la hot wallet (${n.label})`, external_ref: hash, idempotency_key: key,
      metadata: { network: n.id, tx_hash: hash, from, to: hotAddr, block: receipt.blockNumber.toString(), registered_by: by },
      postings: [
        { account: `system:${native.id}:custody`, direction: 'debit', amount: txn.value.toString() },
        { account: `system:${native.id}:equity`, direction: 'credit', amount: txn.value.toString() },
      ],
    });
    if (e.replayed) throw new HttpError(409, 'Ese fondeo ya está registrado', 'already_registered');
    return e.id;
  });
  return getFunding(entryId);
}

const COLS = `e.id, e.created_at, e.external_ref AS tx_hash, e.metadata->>'network' AS network, e.metadata->>'from' AS from_address,
  e.metadata->>'registered_by' AS registered_by, p.asset_id, p.amount::text AS amount, a.decimals`;
const FROM = `FROM journal_entries e JOIN postings p ON p.entry_id = e.id AND p.direction = 'debit' JOIN assets a ON a.id = p.asset_id
  WHERE e.kind = 'gas_funding'`;

async function getFunding(id: string) {
  const { rows: [r] } = await pool.query(`SELECT ${COLS} ${FROM} AND e.id = $1`, [id]);
  return r;
}

export async function listGasFundings(network?: string, limit = 100) {
  const { rows } = await pool.query(
    `SELECT ${COLS} ${FROM} AND ($1::text IS NULL OR e.metadata->>'network' = $1) ORDER BY e.created_at DESC LIMIT $2`,
    [network ?? null, Math.min(Math.max(limit, 1), 500)]);
  return { items: rows };
}

/**
 * Para el tablero, por red: custodia nativa del libro, barridos y retiros detenidos por falta de gas registrado.
 * «Gas sin registrar» lo calcula el tablero comparando con el saldo de la hot wallet en cadena.
 */
export async function gasLedgerStatus() {
  const { rows: nat } = await pool.query(
    `SELECT a.id, a.network, acc.balance::text AS custody FROM assets a JOIN accounts acc ON acc.code = 'system:' || a.id || ':custody'
      WHERE a.kind = 'native' AND a.active`);
  const { rows: sw } = await pool.query(
    `SELECT network, count(*)::int AS n FROM sweeps WHERE status = 'broadcast' AND last_error LIKE $1 GROUP BY network`, [`${STUCK_SWEEP_MSG}%`]);
  const { rows: wd } = await pool.query(
    `SELECT network, count(*)::int AS n FROM withdrawals WHERE status = 'broadcast' AND last_error LIKE $1 GROUP BY network`, [`${STUCK_WD_MSG}%`]);
  const out: Record<string, { native_asset: string; ledger_custody: string; stuck_sweeps: number; stuck_withdrawals: number }> = {};
  for (const n of networks) {
    const a = nat.find((x) => x.network === n.id);
    if (!a) continue;
    out[n.id] = {
      native_asset: a.id, ledger_custody: a.custody,
      stuck_sweeps: sw.find((x) => x.network === n.id)?.n ?? 0, stuck_withdrawals: wd.find((x) => x.network === n.id)?.n ?? 0,
    };
  }
  return out;
}
