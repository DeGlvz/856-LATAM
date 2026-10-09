import {
  encodeFunctionData, decodeEventLog, erc20Abi, isAddress, keccak256, type Address, type Hash, type Hex,
} from 'viem';
import { client } from '../chain.js';
import { getSigner } from '../chain/signer.js';
import { config } from '../config.js';
import { pool, tx, type Tx } from '../db.js';
import { LedgerError, openClientAccount, postEntryIn } from './service.js';

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
}) {
  if (!isAddress(i.to_address)) throw new LedgerError(400, 'Dirección destino inválida', 'invalid_address');
  const to = lower(i.to_address);
  try {
    const id = await tx(async (c) => {
      if (i.idempotency_key) {
        const prev = await c.query('SELECT id FROM withdrawals WHERE idempotency_key = $1', [i.idempotency_key]);
        if (prev.rows[0]) return prev.rows[0].id as string;
      }
      const asset = await getAsset(c, i.asset_id);
      if (asset.chain !== 'ethereum' || asset.network !== config.ALCHEMY_NETWORK || !['native', 'erc20'].includes(asset.kind)) {
        throw new LedgerError(422, `Retiros de ${asset.id} no habilitados en esta red (${config.ALCHEMY_NETWORK})`, 'network_not_supported');
      }
      // Lista blanca: solo a direcciones previamente registradas por el cliente
      const wl = await c.query(
        `SELECT 1 FROM wallets WHERE client_id = $1 AND network = $2 AND address = $3
           AND purpose = 'withdrawal_whitelist' AND active`,
        [i.client_id, asset.network, to],
      );
      if (!wl.rowCount) throw new LedgerError(422, 'Dirección destino fuera de la lista blanca del cliente', 'address_not_whitelisted');

      const acc = await openClientAccount(c, i.client_id, asset.id);
      const { rows: [w] } = await c.query(
        `INSERT INTO withdrawals (client_id, account_id, asset_id, to_address, amount, status, idempotency_key, metadata)
         VALUES ($1,$2,$3,$4,$5,'reserved',$6,$7) RETURNING id`,
        [i.client_id, acc.id, asset.id, to, i.amount, i.idempotency_key ?? null, i.metadata ?? {}],
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
    });
    return getWithdrawal(id);
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
    `SELECT id, client_id, account_id, asset_id, to_address, amount, status, from_address, nonce, tx_hash,
            block_number, confirmations, gas_used, gas_cost_wei, attempts, last_error,
            reserve_entry_id, settle_entry_id, reversal_entry_id, metadata, created_at, updated_at
       FROM withdrawals WHERE id = $1`, [id]);
  if (!w) throw new LedgerError(404, 'Retiro no encontrado', 'not_found');
  return { ...w, required_confirmations: config.CONFIRMATIONS };
}

export async function listWithdrawals(f: { client_id?: string; status?: string; limit?: number }) {
  const { rows } = await pool.query(
    `SELECT id, client_id, asset_id, to_address, amount, status, tx_hash, confirmations, last_error, created_at
       FROM withdrawals WHERE ($1::uuid IS NULL OR client_id = $1) AND ($2::text IS NULL OR status = $2)
      ORDER BY created_at DESC LIMIT $3`,
    [f.client_id ?? null, f.status ?? null, Math.min(f.limit ?? 100, 1000)],
  );
  return rows;
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

export async function cancelWithdrawal(id: string) {
  await tx(async (c) => {
    const { rows: [w] } = await c.query('SELECT * FROM withdrawals WHERE id = $1 FOR UPDATE', [id]);
    if (!w) throw new LedgerError(404, 'Retiro no encontrado', 'not_found');
    if (w.status !== 'reserved') throw new LedgerError(409, `No se puede cancelar un retiro en estado ${w.status}`, 'not_cancellable');
    const rev = await reverseReservation(c, w, 'cancelado por el cliente');
    await c.query(`UPDATE withdrawals SET status = 'cancelled', reversal_entry_id = $2, updated_at = now() WHERE id = $1`, [id, rev]);
  });
  return getWithdrawal(id);
}

// ── Worker: firmar ──
async function signReserved(log: Logger) {
  const signer = getSigner();
  if (!signer) return;
  const from = lower(signer.address());
  const chainId = await client.getChainId();

  for (;;) {
    const done = await tx(async (c) => {
      const { rows: [w] } = await c.query(
        `SELECT * FROM withdrawals WHERE status = 'reserved' ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1`,
      );
      if (!w) return true;
      const asset = await getAsset(c, w.asset_id);
      try {
        const chainNonce = await client.getTransactionCount({ address: from as Address, blockTag: 'pending' });
        const { rows: [m] } = await c.query(
          `SELECT COALESCE(MAX(nonce) + 1, 0) AS n FROM withdrawals WHERE from_address = $1 AND status IN ('signed','broadcast','confirmed')`,
          [from],
        );
        const nonce = Math.max(chainNonce, Number(m.n));
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
        log.info({ withdrawal: w.id, nonce }, 'retiro firmado');
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
async function broadcastSigned(log: Logger) {
  const { rows } = await pool.query(`SELECT id, raw_tx, tx_hash, attempts FROM withdrawals WHERE status = 'signed' ORDER BY nonce`);
  for (const w of rows) {
    try {
      await client.sendRawTransaction({ serializedTransaction: w.raw_tx as Hex });
      await pool.query(`UPDATE withdrawals SET status = 'broadcast', updated_at = now() WHERE id = $1 AND status = 'signed'`, [w.id]);
      log.info({ withdrawal: w.id, tx: w.tx_hash }, 'retiro enviado');
    } catch (e) {
      const msg = (e as Error).message;
      if (/already known|nonce too low|known transaction/i.test(msg)) {
        // Ya está en la red (reintento tras caída): se sigue por recibo
        await pool.query(`UPDATE withdrawals SET status = 'broadcast', updated_at = now() WHERE id = $1 AND status = 'signed'`, [w.id]);
      } else {
        await pool.query(`UPDATE withdrawals SET attempts = attempts + 1, last_error = $2, updated_at = now() WHERE id = $1`,
          [w.id, msg.split('\n')[0].slice(0, 500)]);
        log.warn({ withdrawal: w.id, err: msg.split('\n')[0] }, 'fallo al enviar; se reintentará');
      }
    }
  }
}

// ── Worker: confirmaciones y liquidación contable ──
async function confirmBroadcast(log: Logger) {
  const { rows } = await pool.query(`SELECT id, tx_hash FROM withdrawals WHERE status = 'broadcast' ORDER BY nonce`);
  if (!rows.length) return;
  const head = await client.getBlockNumber({ cacheTime: 0 });
  for (const r of rows) {
    const receipt = await client.getTransactionReceipt({ hash: r.tx_hash as Hash }).catch(() => null);
    if (!receipt) continue;
    const confs = Number(head - receipt.blockNumber + 1n);
    const reverted = receipt.status !== 'success';
    if (!reverted && confs < config.CONFIRMATIONS) {
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
export async function detectDeposits(txHash: string, source: 'api' | 'webhook' = 'api') {
  if (!/^0x[0-9a-fA-F]{64}$/.test(txHash)) throw new LedgerError(400, 'Hash inválido', 'invalid_hash');
  const hash = lower(txHash) as Hash;
  const receipt = await client.getTransactionReceipt({ hash }).catch(() => null);
  if (!receipt) throw new LedgerError(404, 'Transacción no encontrada o aún no minada', 'tx_not_found');
  if (receipt.status !== 'success') throw new LedgerError(422, 'Transacción revertida', 'tx_reverted');
  const txn = await client.getTransaction({ hash });
  const network = config.ALCHEMY_NETWORK;

  const { rows: wallets } = await pool.query(
    `SELECT id, client_id, address FROM wallets WHERE network = $1 AND purpose = 'deposit' AND active AND client_id IS NOT NULL`, [network],
  );
  const byAddr = new Map(wallets.map((w) => [w.address as string, w]));
  const { rows: assets } = await pool.query(`SELECT id, kind, contract_address FROM assets WHERE network = $1 AND active`, [network]);
  const native = assets.find((a) => a.kind === 'native');
  const byContract = new Map(assets.filter((a) => a.contract_address).map((a) => [a.contract_address as string, a]));

  const found: { log_index: number; wallet: (typeof wallets)[number]; asset_id: string; from: string; amount: bigint }[] = [];
  if (native && txn.to && txn.value > 0n && byAddr.has(lower(txn.to))) {
    found.push({ log_index: -1, wallet: byAddr.get(lower(txn.to))!, asset_id: native.id, from: lower(txn.from), amount: txn.value });
  }
  for (const lg of receipt.logs) {
    const asset = byContract.get(lower(lg.address));
    if (!asset || lg.topics[0] !== TRANSFER_TOPIC) continue;
    const ev = decodeEventLog({ abi: erc20Abi, data: lg.data, topics: lg.topics });
    if (ev.eventName !== 'Transfer') continue;
    const { from, to, value } = ev.args as { from: Address; to: Address; value: bigint };
    const w = byAddr.get(lower(to));
    if (w && value > 0n) found.push({ log_index: lg.logIndex, wallet: w, asset_id: asset.id, from: lower(from), amount: value });
  }

  for (const d of found) {
    await pool.query(
      `INSERT INTO deposits (tx_hash, log_index, wallet_id, client_id, asset_id, from_address, amount, block_number, source)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (tx_hash, log_index) DO NOTHING`,
      [hash, d.log_index, d.wallet.id, d.wallet.client_id, d.asset_id, d.from, d.amount.toString(), receipt.blockNumber.toString(), source],
    );
  }
  const { rows } = await pool.query('SELECT * FROM deposits WHERE tx_hash = $1 ORDER BY log_index', [hash]);
  return { tx_hash: hash, deposits: rows, required_confirmations: config.CONFIRMATIONS };
}

export async function listDeposits(f: { client_id?: string; status?: string; limit?: number }) {
  const { rows } = await pool.query(
    `SELECT * FROM deposits WHERE ($1::uuid IS NULL OR client_id = $1) AND ($2::text IS NULL OR status = $2)
      ORDER BY created_at DESC LIMIT $3`,
    [f.client_id ?? null, f.status ?? null, Math.min(f.limit ?? 100, 1000)],
  );
  return rows;
}

async function creditConfirmedDeposits(log: Logger) {
  const { rows } = await pool.query(`SELECT id, tx_hash FROM deposits WHERE status = 'pending' ORDER BY created_at`);
  if (!rows.length) return;
  const head = await client.getBlockNumber({ cacheTime: 0 });
  for (const r of rows) {
    // Revalidar contra la cadena (protege contra reorganizaciones)
    const receipt = await client.getTransactionReceipt({ hash: r.tx_hash as Hash }).catch(() => null);
    if (!receipt || receipt.status !== 'success') continue;
    const confs = Number(head - receipt.blockNumber + 1n);
    if (confs < config.CONFIRMATIONS) {
      await pool.query('UPDATE deposits SET confirmations = $2, block_number = $3 WHERE id = $1', [r.id, confs, receipt.blockNumber.toString()]);
      continue;
    }
    await tx(async (c) => {
      const { rows: [d] } = await c.query(`SELECT * FROM deposits WHERE id = $1 AND status = 'pending' FOR UPDATE`, [r.id]);
      if (!d) return;
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

// ═════════════ TESORERÍA ═════════════

export async function hotWalletStatus() {
  const signer = getSigner();
  if (!signer) return { configured: false };
  const address = signer.address();
  const { rows: assets } = await pool.query(
    `SELECT a.id, a.kind, a.contract_address, acc.balance AS ledger_custody
       FROM assets a JOIN accounts acc ON acc.code = 'system:' || a.id || ':custody'
      WHERE a.network = $1 AND a.active AND a.kind IN ('native','erc20') ORDER BY a.id`, [config.ALCHEMY_NETWORK]);
  const balances = [];
  for (const a of assets) {
    try {
      const onchain = a.kind === 'native'
        ? await client.getBalance({ address })
        : await client.readContract({ address: a.contract_address, abi: erc20Abi, functionName: 'balanceOf', args: [address] });
      balances.push({ asset_id: a.id, onchain: onchain.toString(), ledger_custody: a.ledger_custody,
        difference: (onchain - BigInt(a.ledger_custody)).toString() });
    } catch {
      balances.push({ asset_id: a.id, onchain: null, ledger_custody: a.ledger_custody, difference: null, error: 'contrato no responde en esta red' });
    }
  }
  return { configured: true, signer: signer.kind, address, network: config.ALCHEMY_NETWORK, balances,
    note: 'ledger_custody incluye todas las wallets de la plataforma; difference ≠ 0 indica fondos sin registrar o depósitos en otras direcciones' };
}

export async function ensureHotWalletRegistered() {
  const signer = getSigner();
  if (!signer) return;
  await pool.query(
    `INSERT INTO wallets (chain, network, address, purpose, custody_ref, label)
     VALUES ('ethereum', $1, $2, 'master_hot', $3, 'Hot wallet (firma de retiros)') ON CONFLICT (network, address) DO NOTHING`,
    [config.ALCHEMY_NETWORK, lower(signer.address()), signer.kind],
  );
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
      await signReserved(log);
      await broadcastSigned(log);
      await confirmBroadcast(log);
      await creditConfirmedDeposits(log);
      return { ok: true };
    } finally {
      await c.query('SELECT pg_advisory_unlock(856003)');
    }
  } finally {
    c.release();
    running = false;
  }
}

export function startWorker(log: Logger) {
  const t = setInterval(() => { workerTick(log).catch((e) => log.error({ err: (e as Error).message }, 'error en worker')); },
    config.WORKER_INTERVAL_MS);
  t.unref();
  return () => clearInterval(t);
}
