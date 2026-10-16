import {
  encodeFunctionData, decodeEventLog, erc20Abi, isAddress, keccak256, type Address, type Hash, type Hex,
} from 'viem';
import { createHash } from 'node:crypto';
import { activeNetworks, chainIdOf, findNet, isEnabled, net, networks, primaryNet, type Net } from '../chain/networks.js';
import { assertAssetEnabled, assetStatus } from './client-assets.js';
import { getSigner } from '../chain/signer.js';
import { nextNonce } from '../chain/nonce.js';
import { config } from '../config.js';
import { setupRequired } from '../environment.js';
import { pool, tx, type Tx } from '../db.js';
import { LedgerError, openClientAccount, postEntryIn } from './service.js';
import { registerPendingAddresses } from './deposit-addresses.js';
import { sweepStep } from './sweeps.js';
import { bumpNow, bumpStuck, findReceipt, listAttempts, recordOriginal } from '../chain/replace.js';
import { decodeCursor, page } from '../pagination.js';
import { expirePending } from '../portal/obligations.js';
import { fiatTick, kickPoll } from '../fiat/service.js';

const MAX_ATTEMPTS = 5;
const lower = (a: string) => a.toLowerCase();

type Asset = { id: string; chain: string; network: string; kind: string; contract_address: string | null; decimals: number };

async function getAsset(c: Tx | typeof pool, id: string): Promise<Asset> {
  const { rows: [a] } = await c.query('SELECT * FROM assets WHERE id = $1 AND active', [id]);
  if (!a) throw new LedgerError(422, `Activo no soportado: ${id}`, 'invalid_asset');
  return a;
}
async function nativeAssetOf(c: Tx | typeof pool, network: string): Promise<string> {
  const { rows: [a] } = await c.query(`SELECT id FROM assets WHERE network = $1 AND kind = 'native' AND active`, [network]);
  if (!a) throw new LedgerError(500, `No hay activo nativo registrado para ${network}`, 'no_native_asset');
  return a.id;
}

// ═════════════ RETIROS ═════════════

export async function requestWithdrawal(i: {
  client_id: string; asset_id: string; to_address: string; amount: string;
  idempotency_key?: string; metadata?: Record<string, unknown>;
  requested_by?: string; requested_by_operator?: string | null; needs_approval?: boolean;
  // Fase 3 del portal: salida originada por el cliente desde una simulación
  exit?: {
    approval_status: 'client_pending' | 'pending'; origin_kind: 'client_user' | 'client_key' | 'delegate'; origin_ref: string;
    origin_ip?: string; simulation_id: string; scope_hash: string; dual_required: boolean;
  };
}, inTx?: Tx) {
  if (!isAddress(i.to_address)) throw new LedgerError(400, 'Dirección destino inválida', 'invalid_address');
  const to = lower(i.to_address);
  try {
    const run = async (c: Tx) => {
      if (i.idempotency_key) {
        const prev = await c.query('SELECT id FROM withdrawals WHERE idempotency_key = $1', [i.idempotency_key]);
        if (prev.rows[0]) return prev.rows[0].id as string;
      }
      // Solo clientes activos (KYB aprobado) pueden retirar; se bloquea la fila para evitar carrera con un cambio de estado
      const { rows: [cl] } = await c.query('SELECT status FROM clients WHERE id = $1 FOR SHARE', [i.client_id]);
      if (!cl) throw new LedgerError(404, 'Cliente no encontrado', 'not_found');
      if (cl.status !== 'active') throw new LedgerError(422, `Cliente no activo (estado: ${cl.status}): solo clientes con KYB aprobado pueden retirar`, 'client_not_active');
      const asset = await getAsset(c, i.asset_id);
      if (asset.chain !== 'ethereum' || !isEnabled(asset.network) || !['native', 'erc20'].includes(asset.kind)) {
        throw new LedgerError(422, `Retiros de ${asset.id} no habilitados: la red ${asset.network} no está encendida en esta instalación`, 'network_not_supported');
      }
      // Multi-red: el cliente debe tener el activo habilitado (o en «solo salida»)
      await assertAssetEnabled(c, i.client_id, asset.id, 'out');
      // Lista blanca: solo a direcciones previamente registradas por el cliente
      const wl = await c.query(
        `SELECT 1 FROM wallets WHERE client_id = $1 AND network = $2 AND address = $3
           AND purpose = 'withdrawal_whitelist' AND active AND wl_status = 'active'
           AND (active_from IS NULL OR active_from <= now())`,
        [i.client_id, asset.network, to],
      );
      if (!wl.rowCount) throw new LedgerError(422, 'Dirección destino fuera de la lista blanca del cliente', 'address_not_whitelisted');

      const acc = await openClientAccount(c, i.client_id, asset.id);
      const x = i.exit;
      const { rows: [w] } = await c.query(
        `INSERT INTO withdrawals (client_id, account_id, asset_id, to_address, amount, status, idempotency_key, metadata,
                                  approval_status, requested_by, requested_by_operator,
                                  origin_kind, origin_ref, origin_ip, simulation_id, scope_hash, dual_required, validation_due_at, network)
         VALUES ($1,$2,$3,$4,$5,'reserved',$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,
                 CASE WHEN $8 = 'pending' AND $14::uuid IS NOT NULL THEN now() + make_interval(mins => $17) END, $18) RETURNING id`,
        [i.client_id, acc.id, asset.id, to, i.amount, i.idempotency_key ?? null, i.metadata ?? {},
          x ? x.approval_status : i.needs_approval ? 'pending' : 'not_required', i.requested_by ?? null, i.requested_by_operator ?? null,
          x?.origin_kind ?? (i.requested_by_operator ? 'console' : 'api'), x?.origin_ref ?? null, x?.origin_ip ?? null,
          x?.simulation_id ?? null, x?.scope_hash ?? null, x?.dual_required ?? false, config.EXIT_VALIDATION_SLA_MIN, asset.network],
      );
      // Reserva: el saldo sale de "disponible" y queda "en tránsito" hasta confirmarse
      const e = await postEntryIn(c, {
        kind: 'withdrawal', description: `Reserva retiro ${w.id}`, external_ref: `withdrawal:${w.id}`,
        idempotency_key: `wd-reserve:${w.id}`, metadata: { withdrawal_id: w.id, to },
        postings: [
          { account: acc.id, direction: 'debit', amount: i.amount },
          { account: `system:${asset.id}:withdrawals_pending`, direction: 'credit', amount: i.amount },
        ],
      });
      await c.query('UPDATE withdrawals SET reserve_entry_id = $2 WHERE id = $1', [w.id, e.id]);
      return w.id as string;
    };
    const id = inTx ? await run(inTx) : await tx(run);
    return inTx ? { id } as Awaited<ReturnType<typeof getWithdrawal>> : getWithdrawal(id);
  } catch (e) {
    const err = e as { code?: string };
    if (err.code === '23514') throw new LedgerError(422, 'Saldo insuficiente', 'insufficient_funds');
    if (err.code === '23505' && i.idempotency_key) {
      const prev = await pool.query('SELECT id FROM withdrawals WHERE idempotency_key = $1', [i.idempotency_key]);
      if (prev.rows[0]) return getWithdrawal(prev.rows[0].id);
    }
    throw e;
  }
}

export async function getWithdrawal(id: string) {
  const { rows: [w] } = await pool.query(
    `SELECT w.id, w.client_id, c.name AS client_name, w.account_id, w.asset_id, w.to_address, w.amount, w.status, w.from_address,
            w.nonce, w.tx_hash, w.block_number, w.confirmations, w.gas_used, w.gas_cost_wei, w.attempts, w.last_error,
            w.reserve_entry_id, w.settle_entry_id, w.reversal_entry_id, w.metadata, w.created_at, w.updated_at,
            w.approval_status, w.requested_by, w.requested_by_operator, w.approved_by, w.approved_at, w.rejected_by, w.rejected_reason,
            w.broadcast_at, w.bumps, w.origin_kind, w.origin_ref, w.origin_ip, w.simulation_id, w.scope_hash, w.authorized_hash,
            w.client_approved_by, w.client_approved_at, w.validation_due_at, w.dual_required, w.approved2_by, w.approved2_at, w.network
       FROM withdrawals w JOIN clients c ON c.id = w.client_id WHERE w.id = $1`, [id]);
  if (!w) throw new LedgerError(404, 'Retiro no encontrado', 'not_found');
  return { ...w, required_confirmations: findNet(w.network)?.confirmations ?? config.CONFIRMATIONS, explorer: findNet(w.network)?.explorer ?? null,
    attempts_log: await listAttempts('withdrawal', id) };
}

export async function listWithdrawals(f: { client_id?: string; status?: string; asset_id?: string; approval_status?: string; limit?: number; cursor?: string }) {
  const limit = Math.min(Math.max(f.limit ?? 100, 1), 1000);
  const cur = decodeCursor(f.cursor);
  const { rows } = await pool.query(
    `SELECT w.id, w.client_id, c.name AS client_name, w.asset_id, w.to_address, w.amount, w.status, w.tx_hash, w.nonce,
            w.confirmations, w.attempts, w.last_error, w.created_at, w.updated_at, w.approval_status, w.requested_by,
            w.origin_kind, w.validation_due_at, w.dual_required, w.approved_by, w.network, w.created_at::text AS _ts
       FROM withdrawals w JOIN clients c ON c.id = w.client_id
      WHERE ($1::uuid IS NULL OR w.client_id = $1) AND ($2::text IS NULL OR w.status = $2) AND ($3::text IS NULL OR w.asset_id = $3)
        AND ($4::timestamptz IS NULL OR (w.created_at, w.id) < ($4::timestamptz, $5::uuid))
        AND ($7::text IS NULL OR w.approval_status = $7)
      ORDER BY w.created_at DESC, w.id DESC LIMIT $6`,
    [f.client_id ?? null, f.status ?? null, f.asset_id ?? null, cur?.[0] ?? null, cur?.[1] ?? null, limit + 1, f.approval_status ?? null],
  );
  return page(rows, limit);
}

// Devuelve lo reservado al cliente (cancelación o fallo)
async function reverseReservation(c: Tx, w: { id: string; account_id: string; asset_id: string; amount: string }, why: string) {
  const e = await postEntryIn(c, {
    kind: 'withdrawal', description: `Reverso retiro ${w.id}: ${why}`, external_ref: `withdrawal:${w.id}`,
    idempotency_key: `wd-reverse:${w.id}`, metadata: { withdrawal_id: w.id, reason: why },
    postings: [
      { account: `system:${w.asset_id}:withdrawals_pending`, direction: 'debit', amount: w.amount },
      { account: w.account_id, direction: 'credit', amount: w.amount },
    ],
  });
  return e.id;
}

export async function cancelWithdrawal(id: string, reason = 'cancelado por el cliente') {
  await tx(async (c) => {
    const { rows: [w] } = await c.query('SELECT * FROM withdrawals WHERE id = $1 FOR UPDATE', [id]);
    if (!w) throw new LedgerError(404, 'Retiro no encontrado', 'not_found');
    if (w.status !== 'reserved') throw new LedgerError(409, `No se puede cancelar un retiro en estado ${w.status}`, 'not_cancellable');
    const rev = await reverseReservation(c, w, reason);
    await c.query(`UPDATE withdrawals SET status = 'cancelled', reversal_entry_id = $2, updated_at = now() WHERE id = $1`, [id, rev]);
  });
  return getWithdrawal(id);
}

export const bumpWithdrawal = (id: string, by: string, log?: { info: (o: object, m: string) => void; warn: (o: object, m: string) => void }) =>
  bumpNow('withdrawal', id, by, log);

// ── Alcance de una salida del portal (hash de lo simulado) ──
export function exitScopeHash(f: { client_id: string; asset_id: string; wallet_id: string; to_address: string; amount: string | bigint;
  fee: string | bigint; payable_open: string | bigint }) {
  return createHash('sha256').update(['856-exit/v1', f.client_id, f.asset_id, f.wallet_id, lower(f.to_address),
    String(f.amount), String(f.fee), String(f.payable_open)].join('|')).digest('hex');
}

/** 409 scope_changed si el destino ya no está vigente o la fila del retiro no coincide con la simulación. */
export async function assertScopeUnchanged(c: Tx, w: { id: string; client_id: string; asset_id: string; to_address: string; amount: string; simulation_id: string; scope_hash: string }) {
  const { rows: [sim] } = await c.query('SELECT * FROM exit_simulations WHERE id = $1', [w.simulation_id]);
  const { rows: [wl] } = await c.query(
    `SELECT 1 FROM wallets WHERE id = $1 AND client_id = $2 AND purpose = 'withdrawal_whitelist' AND active AND wl_status = 'active'
       AND (active_from IS NULL OR active_from <= now())`, [sim?.wallet_id, w.client_id]);
  const h = sim && exitScopeHash({ client_id: w.client_id, asset_id: w.asset_id, wallet_id: sim.wallet_id, to_address: w.to_address,
    amount: w.amount, fee: sim.fee, payable_open: sim.payable_open });
  const { rows: [ob] } = await c.query(
    `SELECT COALESCE(sum(amount), 0) AS v FROM obligations WHERE debtor_id = $1 AND asset_id = $2 AND status = 'open'`, [w.client_id, w.asset_id]);
  if (!sim || !wl || h !== w.scope_hash || h !== sim.scope_hash || String(ob.v) !== String(sim.payable_open)) {
    throw new LedgerError(409, 'El alcance cambió desde la simulación (destino, monto u obligaciones); rechace y pida una nueva simulación', 'scope_changed');
  }
}

async function authorizationMatches(c: Tx, w: { id: string; client_id: string; asset_id: string; to_address: string; amount: string; simulation_id: string; scope_hash: string; authorized_hash: string | null }) {
  if (!w.authorized_hash || w.authorized_hash !== w.scope_hash) return false;
  const { rows: [sim] } = await c.query('SELECT wallet_id, fee, payable_open, scope_hash FROM exit_simulations WHERE id = $1', [w.simulation_id]);
  if (!sim || sim.scope_hash !== w.scope_hash) return false;
  return exitScopeHash({ client_id: w.client_id, asset_id: w.asset_id, wallet_id: sim.wallet_id, to_address: w.to_address,
    amount: w.amount, fee: sim.fee, payable_open: sim.payable_open }) === w.authorized_hash;
}

/** Tesoreros activos con 2FA (el umbral de dos tesoreros exige al menos dos). */
export async function treasurersWith2fa(c: Tx | typeof pool) {
  const { rows: [r] } = await c.query(`SELECT count(*)::int AS n FROM operators WHERE role = 'tesorero' AND active AND totp_enabled_at IS NOT NULL`);
  return r.n as number;
}

// ── Doble aprobación ──
export async function approveWithdrawal(id: string, by: { email: string; id: string }) {
  await tx(async (c) => {
    const { rows: [w] } = await c.query('SELECT * FROM withdrawals WHERE id = $1 FOR UPDATE', [id]);
    if (!w) throw new LedgerError(404, 'Retiro no encontrado', 'not_found');
    if (w.status !== 'reserved' || w.approval_status !== 'pending') {
      throw new LedgerError(409, `El retiro no está pendiente de aprobación (estado: ${w.status}/${w.approval_status})`, 'not_pending');
    }
    if (w.requested_by_operator === by.id) throw new LedgerError(403, 'Doble aprobación: quien solicitó no puede aprobar', 'same_operator');
    const { rows: [cl] } = await c.query('SELECT status FROM clients WHERE id = $1 FOR SHARE', [w.client_id]);
    if (cl.status !== 'active') throw new LedgerError(422, `Cliente no activo (estado: ${cl.status}); rechace el retiro`, 'client_not_active');
    // Salida del portal: lo que se autoriza debe ser exactamente lo simulado (destino aún vigente, mismos montos)
    if (w.simulation_id) await assertScopeUnchanged(c, w);
    // Fase M1 — modo de un solo tesorero: el umbral de dos tesoreros solo aplica si hay al menos dos activos con 2FA.
    // Al dar de alta un segundo tesorero vuelve a aplicar sin cambiar código ni configuración.
    const dual = w.dual_required && (await treasurersWith2fa(c)) >= 2;
    if (!dual && w.dual_required) {
      await c.query(
        `UPDATE withdrawals SET approval_status = 'approved',
                approved_by = COALESCE(approved_by, $2), approved_by_operator = COALESCE(approved_by_operator, $3), approved_at = COALESCE(approved_at, now()),
                authorized_hash = scope_hash, metadata = metadata || '{"single_treasurer": true}'::jsonb, updated_at = now() WHERE id = $1`,
        [id, by.email, by.id]);
      return;
    }
    if (dual && !w.approved_by_operator) {
      // Primera de dos autorizaciones: queda pendiente del segundo tesorero
      await c.query(`UPDATE withdrawals SET approved_by = $2, approved_by_operator = $3, approved_at = now(), updated_at = now() WHERE id = $1`,
        [id, by.email, by.id]);
      return;
    }
    if (dual) {
      if (w.approved_by_operator === by.id) throw new LedgerError(403, 'Este monto requiere dos tesoreros distintos', 'same_operator');
      await c.query(
        `UPDATE withdrawals SET approval_status = 'approved', approved2_by = $2, approved2_by_operator = $3, approved2_at = now(),
                authorized_hash = scope_hash, updated_at = now() WHERE id = $1`, [id, by.email, by.id]);
      return;
    }
    await c.query(
      `UPDATE withdrawals SET approval_status = 'approved', approved_by = $2, approved_by_operator = $3, approved_at = now(),
              authorized_hash = scope_hash, updated_at = now() WHERE id = $1`, [id, by.email, by.id]);
  });
  return getWithdrawal(id);
}

export async function rejectWithdrawal(id: string, by: string, reason: string) {
  await tx(async (c) => {
    const { rows: [w] } = await c.query('SELECT * FROM withdrawals WHERE id = $1 FOR UPDATE', [id]);
    if (!w) throw new LedgerError(404, 'Retiro no encontrado', 'not_found');
    if (w.status !== 'reserved' || w.approval_status !== 'pending') {
      throw new LedgerError(409, `El retiro no está pendiente de aprobación (estado: ${w.status}/${w.approval_status})`, 'not_pending');
    }
    const rev = await reverseReservation(c, w, `rechazado por ${by}: ${reason}`);
    await c.query(
      `UPDATE withdrawals SET status = 'cancelled', approval_status = 'rejected', rejected_by = $2, rejected_reason = $3,
              reversal_entry_id = $4, updated_at = now() WHERE id = $1`, [id, by, reason, rev]);
  });
  return getWithdrawal(id);
}

// ── Worker: firmar ──
async function signReserved(n: Net, log: Logger) {
  const signer = getSigner();
  if (!signer) return;
  const from = lower(signer.address());
  const chainId = await chainIdOf(n);
  const client = n.client;

  for (;;) {
    const done = await tx(async (c) => {
      const { rows: [w] } = await c.query(
        // Solo lo que no requiere aprobación o ya fue aprobado por un segundo tesorero
        `SELECT * FROM withdrawals WHERE status = 'reserved' AND approval_status IN ('not_required','approved') AND network = $1
          ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1`, [n.id],
      );
      if (!w) return true;
      const asset = await getAsset(c, w.asset_id);
      if (w.simulation_id && !(await authorizationMatches(c, w))) {
        // Control en profundidad: la fila no coincide con lo autorizado → no se firma; se devuelve el saldo
        const rev = await reverseReservation(c, w, 'la autorización no coincide con el alcance simulado');
        await c.query(`UPDATE withdrawals SET status = 'failed', last_error = $2, reversal_entry_id = $3, updated_at = now() WHERE id = $1`,
          [w.id, 'autorización no coincide con el hash del alcance', rev]);
        log.error({ withdrawal: w.id }, 'retiro bloqueado: la autorización no coincide con el hash');
        return false;
      }
      try {
        const nonce = await nextNonce(c, n, from);
        const call = asset.kind === 'native'
          ? { to: w.to_address as Address, value: BigInt(w.amount), data: undefined }
          : { to: asset.contract_address as Address, value: 0n,
              data: encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [w.to_address as Address, BigInt(w.amount)] }) };
        const gas = await client.estimateGas({ account: from as Address, ...call });
        const fees = await client.estimateFeesPerGas();
        const raw = await signer.signTransaction({
          type: 'eip1559', chainId, nonce, gas: (gas * 12n) / 10n, // +20% de margen
          maxFeePerGas: fees.maxFeePerGas, maxPriorityFeePerGas: fees.maxPriorityFeePerGas, ...call,
        });
        await c.query(
          `UPDATE withdrawals SET status = 'signed', from_address = $2, nonce = $3, raw_tx = $4, tx_hash = $5,
                  last_error = NULL, updated_at = now() WHERE id = $1`,
          [w.id, from, nonce, raw, keccak256(raw)],
        );
        await recordOriginal(c, 'withdrawal', w.id, from, nonce, raw, n.id);
        log.info({ withdrawal: w.id, network: n.id, nonce }, 'retiro firmado');
      } catch (e) {
        const msg = (e as Error).message.split('\n')[0].slice(0, 500);
        const attempts = w.attempts + 1;
        if (attempts >= MAX_ATTEMPTS) {
          const rev = await reverseReservation(c, w, `no se pudo firmar: ${msg}`);
          await c.query(`UPDATE withdrawals SET status = 'failed', attempts = $2, last_error = $3, reversal_entry_id = $4, updated_at = now() WHERE id = $1`,
            [w.id, attempts, msg, rev]);
          log.error({ withdrawal: w.id, err: msg }, 'retiro fallido al firmar; saldo devuelto');
        } else {
          await c.query(`UPDATE withdrawals SET attempts = $2, last_error = $3, updated_at = now() WHERE id = $1`, [w.id, attempts, msg]);
          log.warn({ withdrawal: w.id, err: msg }, 'no se pudo firmar; se reintentará');
          return true; // no insistir en este ciclo
        }
      }
      return false;
    });
    if (done) return;
  }
}

// ── Worker: enviar (y reenviar lo firmado que no salió) ──
async function broadcastSigned(n: Net, log: Logger) {
  const { rows } = await pool.query(`SELECT id, raw_tx, tx_hash, attempts FROM withdrawals WHERE status = 'signed' AND network = $1 ORDER BY nonce`, [n.id]);
  for (const w of rows) {
    try {
      await n.client.sendRawTransaction({ serializedTransaction: w.raw_tx as Hex });
      await pool.query(`UPDATE withdrawals SET status = 'broadcast', broadcast_at = now(), updated_at = now() WHERE id = $1 AND status = 'signed'`, [w.id]);
      log.info({ withdrawal: w.id, tx: w.tx_hash }, 'retiro enviado');
    } catch (e) {
      const msg = (e as Error).message;
      if (/already known|nonce too low|known transaction/i.test(msg)) {
        // Ya está en la red (reintento tras caída): se sigue por recibo
        await pool.query(`UPDATE withdrawals SET status = 'broadcast', broadcast_at = now(), updated_at = now() WHERE id = $1 AND status = 'signed'`, [w.id]);
      } else {
        await pool.query(`UPDATE withdrawals SET attempts = attempts + 1, last_error = $2, updated_at = now() WHERE id = $1`,
          [w.id, msg.split('\n')[0].slice(0, 500)]);
        log.warn({ withdrawal: w.id, err: msg.split('\n')[0] }, 'fallo al enviar; se reintentará');
      }
    }
  }
}

// ── Worker: confirmaciones y liquidación contable ──
async function confirmBroadcast(n: Net, log: Logger) {
  const { rows } = await pool.query(`SELECT id, tx_hash FROM withdrawals WHERE status = 'broadcast' AND network = $1 ORDER BY nonce`, [n.id]);
  if (!rows.length) return;
  const head = await n.client.getBlockNumber({ cacheTime: 0 });
  for (const r of rows) {
    // El hash vigente o cualquier intento anterior (gas bump): se mina solo uno por nonce
    const found = await findReceipt(n, 'withdrawal', r.id, r.tx_hash);
    if (!found) continue;
    const { receipt } = found;
    if (found.hash !== r.tx_hash) {
      await pool.query(`UPDATE withdrawals SET tx_hash = $2, updated_at = now() WHERE id = $1 AND status = 'broadcast'`, [r.id, found.hash]);
      log.info({ withdrawal: r.id, tx: found.hash }, 'se minó un intento anterior; se adopta su hash');
    }
    const confs = Number(head - receipt.blockNumber + 1n);
    const reverted = receipt.status !== 'success';
    if (!reverted && confs < n.confirmations) {
      await pool.query('UPDATE withdrawals SET block_number = $2, confirmations = $3, updated_at = now() WHERE id = $1',
        [r.id, receipt.blockNumber.toString(), confs]);
      continue;
    }
    const gasCost = receipt.gasUsed * receipt.effectiveGasPrice;
    try {
      await tx(async (c) => {
        const { rows: [w] } = await c.query(`SELECT * FROM withdrawals WHERE id = $1 AND status = 'broadcast' FOR UPDATE`, [r.id]);
        if (!w) return;
        const asset = await getAsset(c, w.asset_id);
        const native = await nativeAssetOf(c, asset.network);
        // El gas lo absorbe la plataforma: gasto contra custodia nativa (la hot wallet pagó)
        const gasPostings = gasCost > 0n ? [
          { account: `system:${native}:network_fees`, direction: 'debit' as const, amount: gasCost.toString() },
          { account: `system:${native}:custody`, direction: 'credit' as const, amount: gasCost.toString() },
        ] : [];
        let settle: string | null = null, reversal: string | null = null;
        if (reverted) {
          reversal = await reverseReservation(c, w, 'transacción revertida en cadena');
          if (gasPostings.length) {
            await postEntryIn(c, { kind: 'fee', description: `Gas retiro revertido ${w.id}`, external_ref: w.tx_hash,
              idempotency_key: `wd-gas:${w.id}`, postings: gasPostings });
          }
        } else {
          // Sale de custodia lo que estaba en tránsito
          const e = await postEntryIn(c, {
            kind: 'withdrawal', description: `Retiro confirmado ${w.id}`, external_ref: w.tx_hash,
            idempotency_key: `wd-settle:${w.id}`, metadata: { withdrawal_id: w.id, block: receipt.blockNumber.toString() },
            postings: [
              { account: `system:${w.asset_id}:withdrawals_pending`, direction: 'debit', amount: w.amount },
              { account: `system:${w.asset_id}:custody`, direction: 'credit', amount: w.amount },
              ...gasPostings,
            ],
          });
          settle = e.id;
        }
        await c.query(
          `UPDATE withdrawals SET status = $2, block_number = $3, confirmations = $4, gas_used = $5, gas_cost_wei = $6,
                  settle_entry_id = $7, reversal_entry_id = COALESCE($8, reversal_entry_id), last_error = $9, updated_at = now()
            WHERE id = $1`,
          [w.id, reverted ? 'failed' : 'confirmed', receipt.blockNumber.toString(), confs, receipt.gasUsed.toString(),
           gasCost.toString(), settle, reversal, reverted ? 'revertida en cadena' : null],
        );
      });
      log.info({ withdrawal: r.id, reverted, confs }, reverted ? 'retiro revertido; saldo devuelto' : 'retiro confirmado');
    } catch (e) {
      const code = (e as { code?: string }).code;
      const msg = code === '23514'
        ? 'Custodia insuficiente para registrar el movimiento/gas: registre el fondeo de la hot wallet (asiento adjustment custody/equity)'
        : (e as Error).message.split('\n')[0].slice(0, 500);
      await pool.query('UPDATE withdrawals SET last_error = $2, confirmations = $3, updated_at = now() WHERE id = $1', [r.id, msg, confs]);
      log.error({ withdrawal: r.id, err: msg }, 'no se pudo liquidar el retiro');
    }
  }
}

// ═════════════ DEPÓSITOS ═════════════

const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

/** Detecta depósitos en una transacción (nativos y ERC-20) hacia wallets de depósito registradas. Idempotente. */
export async function detectDeposits(txHash: string, source: 'api' | 'webhook' = 'api', network?: string) {
  if (!/^0x[0-9a-fA-F]{64}$/.test(txHash)) throw new LedgerError(400, 'Hash inválido', 'invalid_hash');
  const hash = lower(txHash) as Hash;
  // Con red conocida (webhook) se busca solo ahí; si no (reporte por hash), en cada red encendida
  let n: Net | null = null;
  let receipt: Awaited<ReturnType<Net['client']['getTransactionReceipt']>> | null = null;
  for (const cand of network ? [net(network)] : activeNetworks()) {
    receipt = await cand.client.getTransactionReceipt({ hash }).catch(() => null);
    if (receipt) { n = cand; break; }
  }
  if (!receipt || !n) throw new LedgerError(404, 'Transacción no encontrada o aún no minada', 'tx_not_found');
  if (receipt.status !== 'success') throw new LedgerError(422, 'Transacción revertida', 'tx_reverted');
  const txn = await n.client.getTransaction({ hash });
  const netId = n.id;

  const { rows: wallets } = await pool.query(
    `SELECT id, client_id, address FROM wallets WHERE network = $1 AND purpose = 'deposit' AND active AND client_id IS NOT NULL`, [netId],
  );
  const byAddr = new Map(wallets.map((w) => [w.address as string, w]));
  // Lo que envía la propia plataforma (p.ej. gas para barrido) no es un depósito de cliente
  const { rows: own } = await pool.query(
    `SELECT address FROM wallets WHERE network = $1 AND purpose IN ('master_hot','master_cold')`, [netId]);
  const platform = new Set(own.map((w) => w.address as string));
  const { rows: assets } = await pool.query(`SELECT id, kind, contract_address FROM assets WHERE network = $1 AND active`, [netId]);
  const native = assets.find((a) => a.kind === 'native');
  const byContract = new Map(assets.filter((a) => a.contract_address).map((a) => [a.contract_address as string, a]));

  const found: { log_index: number; wallet: (typeof wallets)[number]; asset_id: string; from: string; amount: bigint }[] = [];
  if (native && txn.to && txn.value > 0n && byAddr.has(lower(txn.to)) && !platform.has(lower(txn.from))) {
    found.push({ log_index: -1, wallet: byAddr.get(lower(txn.to))!, asset_id: native.id, from: lower(txn.from), amount: txn.value });
  }
  for (const lg of receipt.logs) {
    const asset = byContract.get(lower(lg.address));
    if (!asset || lg.topics[0] !== TRANSFER_TOPIC) continue;
    const ev = decodeEventLog({ abi: erc20Abi, data: lg.data, topics: lg.topics });
    if (ev.eventName !== 'Transfer') continue;
    const { from, to, value } = ev.args as { from: Address; to: Address; value: bigint };
    const w = byAddr.get(lower(to));
    if (w && value > 0n && !platform.has(lower(from))) found.push({ log_index: lg.logIndex, wallet: w, asset_id: asset.id, from: lower(from), amount: value });
  }

  // Fase F1: EURe que llega a la tesorería fiat no es depósito de cliente; solo adelanta la conciliación del proveedor
  const { rows: fiatW } = await pool.query(`SELECT address FROM wallets WHERE network = $1 AND purpose = 'fiat_treasury'`, [netId]);
  if (fiatW.length) {
    const fiatSet = new Set(fiatW.map((w) => w.address as string));
    const toTreasury = receipt.logs.some((lg) => lg.topics[0] === TRANSFER_TOPIC && lg.topics[2] && fiatSet.has(lower(`0x${lg.topics[2].slice(26)}`)));
    if (toTreasury) kickPoll();
  }

  for (const d of found) {
    await pool.query(
      `INSERT INTO deposits (tx_hash, log_index, wallet_id, client_id, asset_id, from_address, amount, block_number, source, network)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT (network, tx_hash, log_index) DO NOTHING`,
      [hash, d.log_index, d.wallet.id, d.wallet.client_id, d.asset_id, d.from, d.amount.toString(), receipt.blockNumber.toString(), source, netId],
    );
  }
  const { rows } = await pool.query('SELECT * FROM deposits WHERE tx_hash = $1 AND network = $2 ORDER BY log_index', [hash, netId]);
  return { tx_hash: hash, network: netId, deposits: rows, required_confirmations: n.confirmations };
}

export async function listDeposits(f: { client_id?: string; status?: string; asset_id?: string; limit?: number; cursor?: string }) {
  const limit = Math.min(Math.max(f.limit ?? 100, 1), 1000);
  const cur = decodeCursor(f.cursor);
  const { rows } = await pool.query(
    `SELECT d.*, c.name AS client_name, w.address AS to_address, d.created_at::text AS _ts
       FROM deposits d JOIN clients c ON c.id = d.client_id JOIN wallets w ON w.id = d.wallet_id
      WHERE ($1::uuid IS NULL OR d.client_id = $1) AND ($2::text IS NULL OR d.status = $2) AND ($3::text IS NULL OR d.asset_id = $3)
        AND ($4::timestamptz IS NULL OR (d.created_at, d.id) < ($4::timestamptz, $5::uuid))
      ORDER BY d.created_at DESC, d.id DESC LIMIT $6`,
    [f.client_id ?? null, f.status ?? null, f.asset_id ?? null, cur?.[0] ?? null, cur?.[1] ?? null, limit + 1],
  );
  return page(rows, limit);
}

async function creditConfirmedDeposits(n: Net, log: Logger) {
  const { rows } = await pool.query(`SELECT id, tx_hash FROM deposits WHERE status = 'pending' AND network = $1 ORDER BY created_at`, [n.id]);
  if (!rows.length) return;
  const head = await n.client.getBlockNumber({ cacheTime: 0 });
  for (const r of rows) {
    // Revalidar contra la cadena (protege contra reorganizaciones)
    const receipt = await n.client.getTransactionReceipt({ hash: r.tx_hash as Hash }).catch(() => null);
    if (!receipt || receipt.status !== 'success') continue;
    const confs = Number(head - receipt.blockNumber + 1n);
    if (confs < n.confirmations) {
      await pool.query('UPDATE deposits SET confirmations = $2, block_number = $3 WHERE id = $1', [r.id, confs, receipt.blockNumber.toString()]);
      continue;
    }
    await tx(async (c) => {
      const { rows: [d] } = await c.query(`SELECT * FROM deposits WHERE id = $1 AND status = 'pending' FOR UPDATE`, [r.id]);
      if (!d) return;
      // Multi-red: si el cliente no tiene el activo habilitado para recibir, el depósito queda en revisión de tesorería
      if ((await assetStatus(c, d.client_id, d.asset_id)) !== 'enabled') {
        await c.query(`UPDATE deposits SET status = 'held', confirmations = $2, held_reason = $3 WHERE id = $1`,
          [d.id, confs, 'activo no habilitado para el cliente']);
        log.warn({ deposit: d.id, asset: d.asset_id }, 'depósito en revisión: activo no habilitado para el cliente');
        return;
      }
      const acc = await openClientAccount(c, d.client_id, d.asset_id);
      const e = await postEntryIn(c, {
        kind: 'deposit', description: `Depósito on-chain ${d.tx_hash}#${d.log_index}`, external_ref: d.tx_hash,
        idempotency_key: `deposit:${d.tx_hash}:${d.log_index}`, metadata: { deposit_id: d.id, from: d.from_address },
        postings: [
          { account: `system:${d.asset_id}:custody`, direction: 'debit', amount: d.amount },
          { account: acc.id, direction: 'credit', amount: d.amount },
        ],
      });
      await c.query(`UPDATE deposits SET status = 'credited', confirmations = $2, entry_id = $3, credited_at = now() WHERE id = $1`,
        [d.id, confs, e.id]);
    });
    log.info({ deposit: r.id, confs }, 'depósito acreditado');
  }
}

/**
 * Depósito en revisión (activo no habilitado al acreditarse): el tesorero lo acredita al cliente.
 * Habilitar el activo para depósitos futuros es una decisión aparte (client_assets).
 */
export async function releaseHeldDeposit(id: string, by: string) {
  await tx(async (c) => {
    const { rows: [d] } = await c.query(`SELECT * FROM deposits WHERE id = $1 FOR UPDATE`, [id]);
    if (!d) throw new LedgerError(404, 'Depósito no encontrado', 'not_found');
    if (d.status !== 'held') throw new LedgerError(409, `El depósito no está en revisión (estado: ${d.status})`, 'not_held');
    const acc = await openClientAccount(c, d.client_id, d.asset_id);
    const e = await postEntryIn(c, {
      kind: 'deposit', description: `Depósito on-chain ${d.tx_hash}#${d.log_index} (liberado por tesorería)`, external_ref: d.tx_hash,
      idempotency_key: `deposit:${d.network}:${d.tx_hash}:${d.log_index}`, metadata: { deposit_id: d.id, from: d.from_address, released_by: by },
      postings: [
        { account: `system:${d.asset_id}:custody`, direction: 'debit', amount: d.amount },
        { account: acc.id, direction: 'credit', amount: d.amount },
      ],
    });
    await c.query(`UPDATE deposits SET status = 'credited', entry_id = $2, credited_at = now(), released_by = $3, released_at = now() WHERE id = $1`,
      [id, e.id, by]);
  });
  const { rows: [d] } = await pool.query('SELECT * FROM deposits WHERE id = $1', [id]);
  return d;
}

// ═════════════ TESORERÍA ═════════════

export async function hotWalletStatus(n: Net = primaryNet) {
  const signer = getSigner();
  if (!signer) return { configured: false };
  const address = signer.address();
  const client = n.client;
  const { rows: assets } = await pool.query(
    `SELECT a.id, a.kind, a.contract_address, acc.balance AS ledger_custody
       FROM assets a JOIN accounts acc ON acc.code = 'system:' || a.id || ':custody'
      WHERE a.network = $1 AND a.active AND a.kind IN ('native','erc20') ORDER BY a.id`, [n.id]);
  // Wallets controladas por la plataforma: hot + direcciones de depósito derivadas (+ tesorería fiat, fase F1)
  const { rows: deps } = await pool.query(
    `SELECT address FROM wallets WHERE network = $1 AND purpose IN ('deposit','fiat_treasury') AND derivation_index IS NOT NULL`, [n.id]);
  const read = (a: { kind: string; contract_address: string | null }, addr: Address) => a.kind === 'native'
    ? client.getBalance({ address: addr })
    : client.readContract({ address: a.contract_address as Address, abi: erc20Abi, functionName: 'balanceOf', args: [addr] });
  const balances = [];
  for (const a of assets) {
    try {
      const hot = await read(a, address);
      let deposits = 0n;
      for (const d of deps) deposits += await read(a, d.address as Address);
      const total = hot + deposits;
      balances.push({ asset_id: a.id, hot_wallet: hot.toString(), deposit_addresses: deposits.toString(), onchain_total: total.toString(),
        ledger_custody: a.ledger_custody, difference: (total - BigInt(a.ledger_custody)).toString() });
    } catch {
      balances.push({ asset_id: a.id, onchain_total: null, ledger_custody: a.ledger_custody, difference: null, error: 'contrato no responde en esta red' });
    }
  }
  return { configured: true, signer: signer.kind, address, network: n.id, deposit_addresses: deps.length, balances,
    note: 'difference = on-chain (hot + depósitos) − custodia en libro. > 0: fondos sin acreditar aún; < 0: alerta' };
}

export async function ensureHotWalletRegistered() {
  const signer = getSigner();
  if (!signer) return;
  // La misma hot wallet firma en todas las redes EVM encendidas: se registra en cada una
  for (const n of networks) {
    await pool.query(
      `INSERT INTO wallets (chain, network, address, purpose, custody_ref, label)
       VALUES ('ethereum', $1, $2, 'master_hot', $3, 'Hot wallet (firma de retiros)') ON CONFLICT (network, address) DO NOTHING`,
      [n.id, lower(signer.address()), signer.kind],
    );
  }
}

// ═════════════ WORKER ═════════════

type Logger = { info: (o: object, m: string) => void; warn: (o: object, m: string) => void; error: (o: object, m: string) => void };
let running = false;

/** Un ciclo: firmar → enviar → confirmar retiros, y acreditar depósitos. Solo una réplica a la vez. */
export async function workerTick(log: Logger) {
  if (running) return { skipped: 'en curso' };
  running = true;
  const c = await pool.connect();
  try {
    const { rows: [l] } = await c.query('SELECT pg_try_advisory_lock(856003) AS ok');
    if (!l.ok) return { skipped: 'otra réplica tiene el candado' };
    try {
      // Una red a la vez; una red caída o con error no detiene a las demás
      const out: Record<string, string> = {};
      for (const n of activeNetworks()) {
        try {
          await signReserved(n, log);
          await broadcastSigned(n, log);
          await confirmBroadcast(n, log);
          await bumpStuck(n, log);
          await creditConfirmedDeposits(n, log);
          await registerPendingAddresses(n, log);
          await sweepStep(n, log);
          n.error = null;
          out[n.id] = 'ok';
        } catch (e) {
          n.error = (e as Error).message.split('\n')[0].slice(0, 200);
          out[n.id] = `error: ${n.error}`;
          log.error({ network: n.id, err: n.error }, 'ciclo del worker con error en esta red');
        }
      }
      await expirePending(); // fase 4: aceptaciones de obligaciones fuera de plazo
      // Fase F1: sondeo y conciliación del proveedor de fiat (respeta FIAT_POLL_INTERVAL_MS; un error no detiene lo demás)
      const fiat = await fiatTick(log).catch((e) => ({ error: (e as Error).message }));
      return { ok: true, networks: out, fiat };
    } finally {
      await c.query('SELECT pg_advisory_unlock(856003)');
    }
  } finally {
    c.release();
    running = false;
  }
}

export function startWorker(log: Logger) {
  const t = setInterval(() => {
    // Modo de alta (production sin tesorero con 2FA): no se firma ni se barre nada
    setupRequired().then((on) => on ? undefined : workerTick(log)).catch((e) => log.error({ err: (e as Error).message }, 'error en worker'));
  },
    config.WORKER_INTERVAL_MS);
  t.unref();
  return () => clearInterval(t);
}
