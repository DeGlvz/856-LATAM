import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const pairs = [
  ['opt-mainnet', 'opt-sepolia', 10, 11155420, 'ETH'],
  ['polygon-mainnet', 'polygon-amoy', 137, 80002, 'POL'],
  ['avax-mainnet', 'avax-fuji', 43114, 43113, 'AVAX'],
  ['linea-mainnet', 'linea-sepolia', 59144, 59141, 'ETH'],
  ['celo-mainnet', 'celo-sepolia', 42220, 11142220, 'CELO'],
  ['unichain-mainnet', 'unichain-sepolia', 130, 1301, 'ETH'],
  ['worldchain-mainnet', 'worldchain-sepolia', 480, 4801, 'ETH'],
];
const testIds = pairs.map((p) => p[1]);
process.env.ALCHEMY_API_KEY = 'unit-test-no-public-rpc';
process.env.API_KEYS = 'unit-test-api-key';
process.env.DATABASE_URL = 'postgres://localhost/wave_unit';
process.env.ENVIRONMENT = 'sandbox';
process.env.ALCHEMY_NETWORK = testIds[0];
process.env.NETWORKS = testIds.join(',');
process.env.CONFIRMATIONS = '3';

const ids = new Map(pairs.map(([, id, , chainId]) => [id, chainId]));
let badNetwork = null, decimals = 6, emptyCode = false;
const calls = [];
const rpc = createServer(async (req, res) => {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  const body = JSON.parse(raw);
  const network = req.url.slice(1);
  calls.push({ network, ...body });
  let result;
  if (body.method === 'eth_chainId') result = `0x${(network === badNetwork ? 31337 : ids.get(network)).toString(16)}`;
  else if (body.method === 'eth_call') result = emptyCode ? '0x' : `0x${decimals.toString(16).padStart(64, '0')}`;
  else throw new Error(`RPC inesperado: ${body.method}`);
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }));
});
rpc.listen(0, '127.0.0.1');
await once(rpc, 'listening');
for (const id of testIds) process.env[`RPC_URL_${id.toUpperCase().replaceAll('-', '_')}`] = `http://127.0.0.1:${rpc.address().port}/${id}`;

const { KNOWN, networks, verifyNetworks, netView, envOfNetwork } = await import('../dist/chain/networks.js');
const { WAVE_1B_ASSETS, verifyAssetDecimals } = await import('../dist/chain/catalog.js');
const log = { info() {}, error() {} };
test.after(() => new Promise((resolve) => { rpc.closeAllConnections(); rpc.close(resolve); }));

test('las 14 redes tienen chainId, ambiente, gas y explorador oficiales', () => {
  for (const [main, sandbox, mainId, testId, native] of pairs) {
    assert.equal(KNOWN[main].chainId, mainId);
    assert.equal(KNOWN[sandbox].chainId, testId);
    assert.equal(envOfNetwork(main), 'production');
    assert.equal(envOfNetwork(sandbox), 'sandbox');
    for (const id of [main, sandbox]) {
      assert.equal(KNOWN[id].native, native);
      assert.match(KNOWN[id].explorer, /^https:\/\//);
      const assets = WAVE_1B_ASSETS.filter((a) => a.network === id);
      assert.equal(assets.filter((a) => a.kind === 'native').length, 1);
      assert.equal(assets.find((a) => a.kind === 'native').symbol, native);
      assert.ok(assets.some((a) => a.symbol === 'USDC'));
    }
  }
});

test('catálogo sin duplicados, solo contratos con fuente y USDC Polygon nativo', () => {
  assert.equal(new Set(WAVE_1B_ASSETS.map((a) => a.id)).size, WAVE_1B_ASSETS.length);
  for (const a of WAVE_1B_ASSETS.filter((a) => a.kind === 'erc20')) {
    assert.match(a.contract, /^0x[0-9a-f]{40}$/);
    assert.equal(a.decimals, 6);
    assert.ok(['developers.circle.com', 'tether.to'].includes(new URL(a.source).hostname));
  }
  assert.equal(WAVE_1B_ASSETS.find((a) => a.id === 'USDC-POLYGON').contract, '0x3c499c542cef5e3811e1192ce70d8cc03d5c3359');
  for (const network of ['opt-mainnet', 'polygon-mainnet', 'linea-mainnet']) {
    assert.ok(!WAVE_1B_ASSETS.some((a) => a.network === network && a.symbol === 'USDT'));
  }
});

test('cada red y activo tiene variables sin valores en .env.example', () => {
  const example = readFileSync(new URL('../.env.example', import.meta.url), 'utf8');
  for (const id of pairs.flatMap(([main, sandbox]) => [main, sandbox])) {
    for (const prefix of ['ALCHEMY_WEBHOOK_ID_', 'ALCHEMY_WEBHOOK_SIGNING_KEY_']) {
      const name = prefix + id.toUpperCase().replaceAll('-', '_');
      assert.match(example, new RegExp(`^${name}=$`, 'm'));
    }
  }
  for (const a of WAVE_1B_ASSETS) assert.match(example, new RegExp(`^SWEEP_MIN_${a.id.replaceAll('-', '_')}=$`, 'm'));
});

test('chainId correcto en las siete cadenas RPC locales y vista sin credenciales', async () => {
  await verifyNetworks(log);
  for (const n of networks) {
    assert.equal(n.chainId, KNOWN[n.id].chainId);
    assert.equal(n.confirmations, 3);
    assert.equal(n.healthy, true);
    assert.ok(!JSON.stringify(netView(n)).includes('127.0.0.1'));
  }
});

test('chainId incorrecto en RPC local rechaza el arranque y no permite operar', async () => {
  badNetwork = 'celo-sepolia';
  try {
    await assert.rejects(verifyNetworks(log), /celo-sepolia: chainId 31337 no coincide con 11142220/);
    assert.equal(networks.find((n) => n.id === badNetwork).healthy, false);
  } finally {
    badNetwork = null;
    await verifyNetworks(log);
  }
});

test('decimals() on-chain por red, desacuerdo y contrato sin código rechazan el arranque', async () => {
  const assets = WAVE_1B_ASSETS.filter((a) => testIds.includes(a.network));
  calls.length = 0;
  await verifyAssetDecimals(assets);
  assert.equal(calls.filter((c) => c.method === 'eth_call').length, 7);
  assert.ok(calls.filter((c) => c.method === 'eth_call').every((c) => c.params[0].data === '0x313ce567'));
  decimals = 18;
  try { await assert.rejects(verifyAssetDecimals(assets), /on-chain 18 no coincide con catálogo 6/); }
  finally { decimals = 6; }
  emptyCode = true;
  try { await assert.rejects(verifyAssetDecimals(assets), /no se pudo verificar decimals/); }
  finally { emptyCode = false; }
});

test('configuración rechaza mezcla main/test en ambos sentidos antes de consultar la base', () => {
  for (const [main, sandbox] of pairs) {
    for (const [environment, primary, other] of [['sandbox', sandbox, main], ['production', main, sandbox]]) {
      const child = spawnSync(process.execPath, ['--input-type=module', '-e',
        "const {configErrors}=await import('./dist/environment.js'); console.log(JSON.stringify(configErrors()));"], {
        encoding: 'utf8', env: { ...process.env, ENVIRONMENT: environment, ALCHEMY_NETWORK: primary, NETWORKS: other },
      });
      assert.equal(child.status, 0, child.stderr);
      assert.ok(JSON.parse(child.stdout.trim()).some((e) => e.includes('no se mezclan')), child.stdout);
    }
  }
});
