import assert from 'node:assert/strict';
import { randomUUID, randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { createPublicClient, defineChain, http } from 'viem';
import { makeApprover } from './approver.mjs';

export function assertLocalUrl(value) {
  const url = new URL(value);
  assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(url.hostname), 'E2E worker: solo se permiten servicios locales');
  return url;
}

export async function until(probe, description, timeout = 30_000) {
  const end = Date.now() + timeout;
  let result;
  do {
    result = await probe();
    if (result) return result;
    await delay(100);
  } while (Date.now() < end);
  assert.fail(`Timeout esperando ${description}; último resultado: ${JSON.stringify(result)}`);
}

/** Red local con chainId real del RPC; compatible con verifyNetworks estricto de ola 1b. */
export async function localChain(rpc, name = 'Local E2E') {
  assertLocalUrl(rpc);
  const client = createPublicClient({ transport: http(rpc) });
  const id = await client.getChainId();
  return defineChain({ id, name, nativeCurrency: { name: 'Native', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [rpc] } } });
}

/**
 * No existe tick global de pruebas. Cada iniciación usa sesión/TOTP y client_id explícito;
 * el timer real hace mantenimiento, observado por recibos y estado de la API.
 */
export function workerDriver({ BASE, KEY, env = process.env, allowSettlementError = false }) {
  assertLocalUrl(BASE);
  let sequence = 0;
  const rpcClients = new Map();
  const api = async (path) => {
    const response = await fetch(BASE + '/v1' + path, { headers: { 'x-api-key': KEY } });
    const body = await response.json();
    assert.equal(response.status, 200, `${path}: ${JSON.stringify(body)}`);
    return body;
  };
  async function rpcFor(network) {
    if (rpcClients.has(network)) return rpcClients.get(network);
    const suffix = network.toUpperCase().replaceAll('-', '_');
    const url = env[`RPC_URL_${suffix}`]
      ?? (network === env.ALCHEMY_NETWORK || network === 'eth-sepolia' ? env.RPC_URL : env.RPC_B);
    assertLocalUrl(url);
    const client = createPublicClient({ transport: http(url, { retryCount: 0, timeout: 2000 }) });
    rpcClients.set(network, client);
    return client;
  }
  async function mined(row, confirmations) {
    const rpc = await rpcFor(row.network);
    let receipt;
    try { receipt = await rpc.getTransactionReceipt({ hash: row.tx_hash }); }
    catch (e) {
      if (e.name === 'TransactionReceiptNotFoundError') return false;
      throw e;
    }
    return receipt.status === 'reverted' || Number(await rpc.getBlockNumber({ cacheTime: 0 }) - receipt.blockNumber + 1n) >= confirmations;
  }
  async function settle(clientId) {
    const networks = (await api('/networks')).networks;
    const confirmations = new Map(networks.map((n) => [n.id, n.confirmations]));
    await until(async () => {
      const [withdrawals, deposits, sweeps] = await Promise.all([
        api(`/withdrawals?client_id=${clientId}&limit=1000`),
        api(`/deposits?client_id=${clientId}&limit=1000`), api('/sweeps?limit=1000'),
      ]);
      const rows = [
        ...withdrawals.withdrawals,
        ...deposits.deposits,
        ...sweeps.sweeps.filter((s) => s.client_id === clientId),
      ];
      for (const row of rows) {
        if (row.status === 'signed') return false;
        if (!['broadcast', 'pending'].includes(row.status)) continue;
        if (!confirmations.has(row.network)) continue;
        if (allowSettlementError && row.last_error?.match(/Custodia .*insuficiente/)) continue;
        if (await mined(row, confirmations.get(row.network))) return false;
      }
      return true;
    }, `mantenimiento real del cliente ${clientId}`);
  }
  return {
    settle,
    async run(clientId, { expectedStatus = 'ok' } = {}) {
      assert.match(clientId, /^[0-9a-f-]{36}$/i, 'Un disparo requiere exactamente un cliente explícito');
      await settle(clientId);
      // Actores independientes de prueba: cada disparo prueba TOTP real sin adelantar el reloj ni reutilizar códigos.
      const ip = `10.${[...randomBytes(3)].join('.')}`;
      const actor = await makeApprover({ BASE, ip, tag: `worker-${randomUUID()}`, env });
      const view = await actor.call('GET', `/v1/console/worker/clients/${clientId}`);
      assert.equal(view.status, 200, JSON.stringify(view.body));
      assert.equal(view.body.worker_enabled, true, 'Arranque el servicio local con WORKER_ENABLED=true');
      assert.equal(view.body.setup_required, false);
      assert.equal(view.body.policy.mode, 'manual', 'Los clientes del escenario no deben iniciar trabajo automáticamente');
      const request_id = randomUUID();
      let response;
      for (let attempt = 0; attempt < 5; attempt++) {
        response = await actor.call('POST', `/v1/console/worker/clients/${clientId}/run`, { request_id, code: await actor.code() });
        if (response.body?.code !== 'worker_busy') break;
        await delay(100);
      }
      sequence++;
      assert.equal(response.status, 200, `disparo ${sequence}: ${JSON.stringify(response.body)}`);
      assert.equal(response.body.client_id, clientId);
      assert.equal(response.body.status, expectedStatus, JSON.stringify(response.body));
      await settle(clientId);
      return { status: 200, body: response.body };
    },
  };
}
