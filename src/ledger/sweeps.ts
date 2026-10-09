import { encodeFunctionData, erc20Abi, keccak256, type Address, type Hash, type Hex } from 'viem';
import { client } from '../chain.js';
import { nextNonce } from '../chain/nonce.js';
import { getDepositKeyring, getSigner, type Signer } from '../chain/signer.js';
import { config } from '../config.js';
import { pool, tx } from '../db.js';
import { postEntryIn } from './service.js';

type Log = { info: (o: object, m: string) => void; warn: (o: object, m: string) => void; error: (o: object, m: string) => void };
type Kind = 'gas_topup' | 'sweep_token' | 'sweep_native';

/**
 * Barrido: concentra en la hot wallet lo que llega a las direcciones de depósito.
 * Son movimientos internos (la custodia total no cambia); solo el gas se registra como gasto.
 * Si una dirección tiene tokens pero no ETH para gas, primero la hot wallet le envía gas (gas_topup).
 */
export async function sweepStep(log: Log) {
  const hot = getSigner();
  const keyring = getDepositKeyring();
  if (!hot || !keyring || !config.SWEEP_ENABLED) return;
  await broadcastSweeps(log);
  await confirmSweeps(log);

  const network = config.ALCHEMY_NETWORK;
  const hotAddr = hot.address().toLowerCase();
  const { rows: native } = await pool.query(`SELECT id FROM assets WHERE network = $1 AND kind = 'native' AND active`, [network]);
  if (!native[0]) return;
  const nativeId = native[0].id as string;
  const { rows: tokens } = await pool.query(
    `SELECT id, contract_address FROM assets WHERE network = $1 AND kind = 'erc20' AND active ORDER BY id`, [network]);
  const { rows: wallets } = await pool.query(
    `SELECT w.id, w.address, w.derivation_index FROM wallets w
      WHERE w.network = $1 AND w.purpose = 'deposit' AND w.derivation_index IS NOT NULL AND w.active
        AND NOT EXISTS (SELECT 1 FROM sweeps s WHERE s.wallet_id = w.id AND s.status IN ('signed','broadcast'))
      ORDER BY w.derivation_index`, [network]);
  if (!wallets.length) return;
  const fees = await client.estimateFeesPerGas();
  const chainId = await client.getChainId();

  for (const w of wallets) {
    try {
      const depSigner = keyring.derive(w.derivation_index);
      const eth = await client.getBalance({ address: w.address as Address });
      let token: { id: string; contract_address: string; bal: bigint } | null = null;
      for (const t of tokens) {
        const bal = await client.readContract({ address: t.contract_address, abi: erc20Abi, functionName: 'balanceOf', args: [w.address as Address] }).catch(() => 0n);
        if (bal > 0n) { token = { ...t, bal }; break; }
      }

      if (token) {
        const data = encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [hotAddr as Address, token.bal] });
        const gas = (await client.estimateGas({ account: w.address as Address, to: token.contract_address as Address, data }) * 12n) / 10n;
        const need = gas * fees.maxFeePerGas;
        if (eth < need) {
          // Fondear gas desde la hot wallet (con margen para un segundo barrido)
          await createSweep(log, { wallet_id: w.id, kind: 'gas_topup', asset_id: nativeId, amount: need * 2n - eth,
            signer: hot, to: w.address, value: need * 2n - eth, gas: 21000n, chainId, fees });
        } else {
          await createSweep(log, { wallet_id: w.id, kind: 'sweep_token', asset_id: token.id, amount: token.bal,
            signer: depSigner, to: token.contract_address, value: 0n, data, gas, chainId, fees });
        }
      } else if (eth >= config.SWEEP_MIN_NATIVE_WEI) {
        const gas = 21000n;
        const value = eth - gas * fees.maxFeePerGas;
        if (value > 0n) {
          await createSweep(log, { wallet_id: w.id, kind: 'sweep_native', asset_id: nativeId, amount: value,
            signer: depSigner, to: hotAddr, value, gas, chainId, fees });
        }
      }
    } catch (e) {
      log.warn({ wallet: w.id, err: (e as Error).message.split('\n')[0] }, 'barrido omitido en este ciclo');
    }
  }
  await broadcastSweeps(log);
}

async function createSweep(log: Log, s: {
  wallet_id: string; kind: Kind; asset_id: string; amount: bigint; signer: Signer; to: string; value: bigint;
  data?: Hex; gas: bigint; chainId: number; fees: { maxFeePerGas: bigint; maxPriorityFeePerGas: bigint };
}) {
  const from = s.signer.address().toLowerCase();
  await tx(async (c) => {
    const nonce = await nextNonce(c, from);
    const raw = await s.signer.signTransaction({
      type: 'eip1559', chainId: s.chainId, nonce, gas: s.gas, to: s.to as Address, value: s.value, data: s.data,
      maxFeePerGas: s.fees.maxFeePerGas, maxPriorityFeePerGas: s.fees.maxPriorityFeePerGas,
    });
    await c.query(
      `INSERT INTO sweeps (wallet_id, kind, asset_id, amount, from_address, to_address, nonce, raw_tx, tx_hash, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'signed')`,
      [s.wallet_id, s.kind, s.asset_id, s.amount.toString(), from, s.to.toLowerCase(), nonce, raw, keccak256(raw)],
    );
  });
  log.info({ wallet: s.wallet_id, kind: s.kind, amount: s.amount.toString() }, 'barrido firmado');
}

async function broadcastSweeps(log: Log) {
  const { rows } = await pool.query(`SELECT id, raw_tx FROM sweeps WHERE status = 'signed' ORDER BY created_at`);
  for (const s of rows) {
    try {
      await client.sendRawTransaction({ serializedTransaction: s.raw_tx as Hex });
      await pool.query(`UPDATE sweeps SET status = 'broadcast', updated_at = now() WHERE id = $1`, [s.id]);
    } catch (e) {
      const msg = (e as Error).message;
      if (/already known|nonce too low|known transaction/i.test(msg)) {
        await pool.query(`UPDATE sweeps SET status = 'broadcast', updated_at = now() WHERE id = $1`, [s.id]);
      } else {
        await pool.query(`UPDATE sweeps SET last_error = $2, updated_at = now() WHERE id = $1`, [s.id, msg.split('\n')[0].slice(0, 500)]);
        log.warn({ sweep: s.id, err: msg.split('\n')[0] }, 'fallo al enviar barrido');
      }
    }
  }
}

async function confirmSweeps(log: Log) {
  const { rows } = await pool.query(`SELECT id, tx_hash FROM sweeps WHERE status = 'broadcast'`);
  if (!rows.length) return;
  const head = await client.getBlockNumber({ cacheTime: 0 });
  const { rows: [nat] } = await pool.query(`SELECT id FROM assets WHERE network = $1 AND kind = 'native' AND active`, [config.ALCHEMY_NETWORK]);
  for (const r of rows) {
    const receipt = await client.getTransactionReceipt({ hash: r.tx_hash as Hash }).catch(() => null);
    if (!receipt || Number(head - receipt.blockNumber + 1n) < config.CONFIRMATIONS) continue;
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
      const msg = code === '23514' ? 'Custodia ETH insuficiente en libro para registrar gas de barrido' : (e as Error).message.split('\n')[0];
      await pool.query(`UPDATE sweeps SET last_error = $2, updated_at = now() WHERE id = $1`, [r.id, msg.slice(0, 500)]);
      log.error({ sweep: r.id, err: msg }, 'no se pudo liquidar barrido');
    }
  }
}

export async function listSweeps(limit = 100) {
  const { rows } = await pool.query(
    `SELECT id, wallet_id, kind, asset_id, amount, from_address, to_address, tx_hash, status, gas_cost_wei, last_error, created_at
       FROM sweeps ORDER BY created_at DESC LIMIT $1`, [Math.min(limit, 1000)]);
  return rows;
}
