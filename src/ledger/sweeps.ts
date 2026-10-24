import { encodeFunctionData, erc20Abi, keccak256, type Address, type Hash, type Hex } from 'viem';
import { chainIdOf, type Net } from '../chain/networks.js';
import { nextNonce } from '../chain/nonce.js';
import { getDepositKeyring, getSigner, type Signer } from '../chain/signer.js';
import { config } from '../config.js';
import { decodeCursor, page } from '../pagination.js';
import { pool, tx } from '../db.js';
import { postEntryIn } from './service.js';
import { findReceipt, recordOriginal } from '../chain/replace.js';

type Log = { info: (o: object, m: string) => void; warn: (o: object, m: string) => void; error: (o: object, m: string) => void };
type Kind = 'gas_topup' | 'sweep_token' | 'sweep_native';

/**
 * Barrido: concentra en la hot wallet lo que llega a las direcciones de depósito.
 * Son movimientos internos (la custodia total no cambia); solo el gas se registra como gasto.
 * Si una dirección tiene tokens pero no ETH para gas, primero la hot wallet le envía gas (gas_topup).
 */
/**
 * Mínimo para barrer un activo, en unidades base: variable SWEEP_MIN_<ID DEL ACTIVO> (guiones → guion bajo),
 * p. ej. SWEEP_MIN_USDT_MAINNET=50000000 (50 USDT). Sin variable: el valor por defecto (nativo: SWEEP_MIN_NATIVE_WEI).
 * Debajo del mínimo el depósito se acredita igual al cliente; solo se espera a juntar más antes de barrer.
 */
export function sweepMin(assetId: string, fallback: bigint): bigint {
  const v = process.env[`SWEEP_MIN_${assetId.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`]?.trim();
  if (!v) return fallback;
  if (!/^\d+$/.test(v)) throw new Error(`SWEEP_MIN de ${assetId} debe ser un entero en unidades base`);
  return BigInt(v);
}

/** Saldos ERC-20 de una dirección en una sola llamada (multicall); si la red no lo soporta, cae a lecturas individuales. */
async function tokenBalances(client: Net['client'], tokens: { contract_address: string }[], addr: Address): Promise<bigint[]> {
  if (!tokens.length) return [];
  const one = (t: { contract_address: string }) =>
    client.readContract({ address: t.contract_address as Address, abi: erc20Abi, functionName: 'balanceOf', args: [addr] });
  if (tokens.length === 1) return [await one(tokens[0])];
  try {
    const res = await client.multicall({
      contracts: tokens.map((t) => ({ address: t.contract_address as Address, abi: erc20Abi, functionName: 'balanceOf' as const, args: [addr] as const })),
      allowFailure: false,
    });
    return res.map((value) => {
      if (typeof value !== 'bigint') throw new Error('Respuesta de saldo ERC-20 inválida');
      return value;
    });
  } catch {
    return Promise.all(tokens.map(one));
  }
}

export async function maintainSweeps(n: Net, log: Log) {
  await broadcastSweeps(n, log);
  await confirmSweeps(n, log);
}

export async function sweepStep(n: Net, log: Log, clientId: string | null) {
  const hot = getSigner();
  const keyring = getDepositKeyring();
  if (!config.SWEEP_ENABLED) return 'disabled';
  if (!hot || !keyring) throw new Error('Barrido sin firmante o semilla HD configurados');
  const network = n.id;
  const client = n.client;
  const hotAddr = hot.address().toLowerCase();
  const { rows: native } = await pool.query(`SELECT id FROM assets WHERE network = $1 AND kind = 'native' AND active`, [network]);
  if (!native[0]) throw new Error(`No hay activo nativo activo para ${network}`);
  const nativeId = native[0].id as string;
  const { rows: tokens } = await pool.query(
    `SELECT id, contract_address FROM assets WHERE network = $1 AND kind = 'erc20' AND active
       AND ($2::uuid IS NULL OR EXISTS (SELECT 1 FROM client_assets ca WHERE ca.client_id = $2 AND ca.asset_id = assets.id))
       ORDER BY id`, [network, clientId]);
  const { rows: wallets } = await pool.query(
    `SELECT w.id, w.address, w.derivation_index
       FROM wallets w
      WHERE w.network = $1 AND w.purpose IN ('deposit','fiat_treasury','fiat_client')
        AND w.derivation_index IS NOT NULL AND w.active AND w.hd_generation = $3
        AND w.client_id IS NOT DISTINCT FROM $2::uuid
        AND NOT EXISTS (SELECT 1 FROM sweeps s WHERE s.wallet_id = w.id AND s.status IN ('signed','broadcast'))
            ORDER BY w.derivation_index`, [network, clientId, config.HD_GENERATION]);
  if (!wallets.length) return 'no_wallets';
  const fees = await client.estimateFeesPerGas();
  const chainId = await chainIdOf(n);

  const errors: string[] = [];
  const nativeAllowed = clientId === null || (await pool.query(
    'SELECT 1 FROM client_assets WHERE client_id = $1 AND asset_id = $2', [clientId, nativeId])).rowCount;
  for (const w of wallets) {
    try {
      const depSigner = keyring.derive(w.derivation_index);
      const eth = await client.getBalance({ address: w.address as Address });
      let token: { id: string; contract_address: string; bal: bigint } | null = null;
      const bals = await tokenBalances(client, tokens, w.address as Address);
      for (let i = 0; i < tokens.length; i++) {
        const t = tokens[i];
        const bal = bals[i];
        // Fase M1: solo se barre al superar el mínimo del activo (en Ethereum el gas hace incosteable barrer montos chicos)
        if (bal > 0n && bal >= sweepMin(t.id, 1n)) { token = { ...t, bal }; break; }
      }

      if (token) {
        const data = encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [hotAddr as Address, token.bal] });
        const gas = (await client.estimateGas({ account: w.address as Address, to: token.contract_address as Address, data }) * 12n) / 10n;
        const need = gas * fees.maxFeePerGas;
        if (eth < need) {
          // Fondear gas desde la hot wallet (con margen para un segundo barrido)
          await createSweep(log, { wallet_id: w.id, kind: 'gas_topup', asset_id: nativeId, amount: need * 2n - eth,
            signer: hot, to: w.address, value: need * 2n - eth, gas: 21000n, chainId, fees, n });
        } else {
          await createSweep(log, { wallet_id: w.id, kind: 'sweep_token', asset_id: token.id, amount: token.bal,
            signer: depSigner, to: token.contract_address, value: 0n, data, gas, chainId, fees, n });
        }
      } else if (nativeAllowed && eth >= sweepMin(nativeId, config.SWEEP_MIN_NATIVE_WEI)) {
        const gas = 21000n;
        const value = eth - gas * fees.maxFeePerGas;
        if (value > 0n) {
          await createSweep(log, { wallet_id: w.id, kind: 'sweep_native', asset_id: nativeId, amount: value,
            signer: depSigner, to: hotAddr, value, gas, chainId, fees, n });
        }
      }
    } catch (e) {
      log.warn({ wallet: w.id, err: (e as Error).message.split('\n')[0] }, 'barrido omitido en este ciclo');
      errors.push(`${w.id}: ${(e as Error).message.split('\n')[0]}`);
    }
  }
  if (errors.length) throw new Error(errors.join('; ').slice(0, 1000));
  return 'ok';
}

async function createSweep(log: Log, s: {
  wallet_id: string; kind: Kind; asset_id: string; amount: bigint; signer: Signer; to: string; value: bigint;
  data?: Hex; gas: bigint; chainId: number; fees: { maxFeePerGas: bigint; maxPriorityFeePerGas: bigint }; n: Net;
}) {
  const from = s.signer.address().toLowerCase();
  await tx(async (c) => {
    const nonce = await nextNonce(c, s.n, from);
    const raw = await s.signer.signTransaction({
      type: 'eip1559', chainId: s.chainId, nonce, gas: s.gas, to: s.to as Address, value: s.value, data: s.data,
      maxFeePerGas: s.fees.maxFeePerGas, maxPriorityFeePerGas: s.fees.maxPriorityFeePerGas,
    });
    const { rows: [row] } = await c.query(
      `INSERT INTO sweeps (wallet_id, kind, asset_id, amount, from_address, to_address, nonce, raw_tx, tx_hash, status, network)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'signed',$10) RETURNING id`,
      [s.wallet_id, s.kind, s.asset_id, s.amount.toString(), from, s.to.toLowerCase(), nonce, raw, keccak256(raw), s.n.id],
    );
    await recordOriginal(c, 'sweep', row.id, from, nonce, raw, s.n.id);
  });
  log.info({ wallet: s.wallet_id, kind: s.kind, amount: s.amount.toString() }, 'barrido firmado');
}

async function broadcastSweeps(n: Net, log: Log) {
  const { rows } = await pool.query(`SELECT id, raw_tx FROM sweeps WHERE status = 'signed' AND network = $1 ORDER BY created_at`, [n.id]);
  for (const s of rows) {
    try {
      await n.client.sendRawTransaction({ serializedTransaction: s.raw_tx as Hex });
      await pool.query(`UPDATE sweeps SET status = 'broadcast', broadcast_at = now(), updated_at = now() WHERE id = $1`, [s.id]);
    } catch (e) {
      const msg = (e as Error).message;
      if (/already known|nonce too low|known transaction/i.test(msg)) {
        await pool.query(`UPDATE sweeps SET status = 'broadcast', broadcast_at = now(), updated_at = now() WHERE id = $1`, [s.id]);
      } else {
        await pool.query(`UPDATE sweeps SET last_error = $2, updated_at = now() WHERE id = $1`, [s.id, msg.split('\n')[0].slice(0, 500)]);
        log.warn({ sweep: s.id, err: msg.split('\n')[0] }, 'fallo al enviar barrido');
      }
    }
  }
}

async function confirmSweeps(n: Net, log: Log) {
  const { rows } = await pool.query(`SELECT id, tx_hash FROM sweeps WHERE status = 'broadcast' AND network = $1`, [n.id]);
  if (!rows.length) return;
  const head = await n.client.getBlockNumber({ cacheTime: 0 });
  const { rows: [nat] } = await pool.query(`SELECT id FROM assets WHERE network = $1 AND kind = 'native' AND active`, [n.id]);
  for (const r of rows) {
    const found = await findReceipt(n, 'sweep', r.id, r.tx_hash);
    if (!found || Number(head - found.receipt.blockNumber + 1n) < n.confirmations) continue;
    const { receipt } = found;
    if (found.hash !== r.tx_hash) await pool.query(`UPDATE sweeps SET tx_hash = $2, updated_at = now() WHERE id = $1 AND status = 'broadcast'`, [r.id, found.hash]);
    const gasCost = receipt.gasUsed * receipt.effectiveGasPrice;
    try {
      await tx(async (c) => {
        const { rows: [s] } = await c.query(`SELECT * FROM sweeps WHERE id = $1 AND status = 'broadcast' FOR UPDATE`, [r.id]);
        if (!s) return;
        let entry: string | null = null;
        if (gasCost > 0n) {
          entry = (await postEntryIn(c, {
            kind: 'fee', description: `Gas de barrido (${s.kind}) ${s.id}`, external_ref: s.tx_hash,
            idempotency_key: `sweep-gas:${s.id}`, metadata: { sweep_id: s.id, kind: s.kind },
            postings: [
              { account: `system:${nat.id}:network_fees`, direction: 'debit', amount: gasCost.toString() },
              { account: `system:${nat.id}:custody`, direction: 'credit', amount: gasCost.toString() },
            ],
          })).id;
        }
        await c.query(
          `UPDATE sweeps SET status = $2, block_number = $3, gas_cost_wei = $4, gas_entry_id = $5, updated_at = now(),
                  last_error = $6 WHERE id = $1`,
          [s.id, receipt.status === 'success' ? 'confirmed' : 'failed', receipt.blockNumber.toString(), gasCost.toString(), entry,
           receipt.status === 'success' ? null : 'revertida en cadena'],
        );
      });
      log.info({ sweep: r.id, status: receipt.status }, 'barrido liquidado');
    } catch (e) {
      const code = (e as { code?: string }).code;
      const msg = code === '23514' ? 'Custodia nativa insuficiente en libro para registrar gas de barrido: registre el fondeo de gas (Tablero → Registrar fondeo de gas)' : (e as Error).message.split('\n')[0];
      await pool.query(`UPDATE sweeps SET last_error = $2, updated_at = now() WHERE id = $1`, [r.id, msg.slice(0, 500)]);
      log.error({ sweep: r.id, err: msg }, 'no se pudo liquidar barrido');
    }
  }
}

export async function listSweeps(f: { status?: string; kind?: string; limit?: number; cursor?: string } = {}) {
  const limit = Math.min(Math.max(f.limit ?? 100, 1), 1000);
  const cur = decodeCursor(f.cursor);
  const { rows } = await pool.query(
    `SELECT s.id, s.wallet_id, w.client_id, c.name AS client_name, s.kind, s.asset_id, s.amount, s.from_address, s.to_address,
            s.nonce, s.tx_hash, s.status, s.block_number, s.gas_cost_wei, s.last_error, s.created_at, s.updated_at, s.bumps, s.broadcast_at, s.network,
            s.created_at::text AS _ts
       FROM sweeps s JOIN wallets w ON w.id = s.wallet_id LEFT JOIN clients c ON c.id = w.client_id
      WHERE ($1::text IS NULL OR s.status = $1) AND ($2::text IS NULL OR s.kind = $2)
        AND ($3::timestamptz IS NULL OR (s.created_at, s.id) < ($3::timestamptz, $4::uuid))
      ORDER BY s.created_at DESC, s.id DESC LIMIT $5`,
    [f.status ?? null, f.kind ?? null, cur?.[0] ?? null, cur?.[1] ?? null, limit + 1]);
  return page(rows, limit);
}
