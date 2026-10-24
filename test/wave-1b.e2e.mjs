import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import solc from 'solc';
import { createPublicClient, createWalletClient, defineChain, erc20Abi, http, parseEther } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';

const databaseUrl = process.env.DATABASE_URL;
assert.ok(databaseUrl, 'DATABASE_URL debe apuntar a PostgreSQL de pruebas; se crean y eliminan esquemas aislados');
process.env.ALCHEMY_API_KEY ??= 'local-test-no-public-rpc';
process.env.API_KEYS ??= 'local-test-api-key';
const { WAVE_1B_ASSETS } = await import('../dist/chain/catalog.js');
const { KNOWN } = await import('../dist/chain/networks.js');
const { pool: importedPool } = await import('../dist/db.js');
await importedPool.end();

const require = createRequire(import.meta.url);
const hardhatCli = require.resolve('hardhat/internal/cli/cli.js');
const hardhatConfig = fileURLToPath(new URL('./lib/hardhat.config.cjs', import.meta.url));
const admin = new pg.Pool({ connectionString: databaseUrl });
test.after(() => admin.end());
const source = `pragma solidity ^0.8.20;
contract LocalToken {
  mapping(address => uint256) public balanceOf;
  event Transfer(address indexed from, address indexed to, uint256 value);
  function decimals() external pure returns (uint8) { return 6; }
  function mint(address to, uint256 amount) external { balanceOf[to] += amount; emit Transfer(address(0), to, amount); }
  function transfer(address to, uint256 amount) external returns (bool) {
    require(balanceOf[msg.sender] >= amount);
    balanceOf[msg.sender] -= amount; balanceOf[to] += amount;
    emit Transfer(msg.sender, to, amount); return true;
  }
}`;
const compiled = JSON.parse(solc.compile(JSON.stringify({
  language: 'Solidity', sources: { 'LocalToken.sol': { content: source } },
  settings: { evmVersion: 'cancun', outputSelection: { '*': { '*': ['abi', 'evm.deployedBytecode.object'] } } },
})));
assert.deepEqual((compiled.errors ?? []).filter((e) => e.severity === 'error'), []);
const token = compiled.contracts['LocalToken.sol'].LocalToken;

async function freePort() {
  const socket = createServer();
  socket.listen(0, '127.0.0.1');
  await once(socket, 'listening');
  const port = socket.address().port;
  await new Promise((resolve) => socket.close(resolve));
  return port;
}
function start(args, env) {
  const child = spawn(process.execPath, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', (data) => { output += data; });
  child.stderr.on('data', (data) => { output += data; });
  return { child, output: () => output };
}
async function stop(proc) {
  if (!proc || proc.child.exitCode !== null) return;
  const exited = once(proc.child, 'exit');
  proc.child.kill();
  await exited;
}
async function ready(proc, probe) {
  for (let i = 0; i < 300; i++) {
    if (proc.child.exitCode !== null) assert.fail(`Proceso terminó antes de estar listo: ${proc.output()}`);
    try { if (await probe()) return; } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.fail(`Proceso no respondió: ${proc.output()}`);
}
async function rejected(proc, expected) {
  let timer;
  try {
    const [code] = await Promise.race([
      once(proc.child, 'exit'),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('El arranque no fue rechazado')), 30_000); }),
    ]);
    assert.equal(code, 1, proc.output());
    assert.match(proc.output(), expected);
    assert.ok(!proc.output().includes('Server listening'));
  } finally {
    clearTimeout(timer);
  }
}

for (const network of ['opt-sepolia', 'polygon-amoy', 'avax-fuji', 'linea-sepolia', 'celo-sepolia', 'unichain-sepolia', 'worldchain-sepolia']) {
  test(`${network}: depósito nativo/token, gas nativo, barrido, retiro autorizado y conciliación cero`, { timeout: 120_000 }, async () => {
    const schema = `wave_${randomBytes(8).toString('hex')}`;
    await admin.query(`CREATE SCHEMA "${schema}"`);
    const url = new URL(databaseUrl);
    url.searchParams.set('options', `-csearch_path=${schema},public`);
    const scoped = new pg.Pool({ connectionString: url.toString() });
    let node, server;
    try {
      const rpcPort = await freePort(), apiPort = await freePort();
      const rpc = `http://127.0.0.1:${rpcPort}`, base = `http://127.0.0.1:${apiPort}`;
      const chainId = KNOWN[network].chainId;
      node = start([hardhatCli, 'node', '--config', hardhatConfig, '--hostname', '127.0.0.1', '--port', String(rpcPort)], {
        ...process.env, LOCAL_CHAIN_ID: String(chainId),
      });
      const chain = defineChain({ id: chainId, name: network, nativeCurrency: { name: KNOWN[network].native, symbol: KNOWN[network].native, decimals: 18 }, rpcUrls: { default: { http: [rpc] } } });
      const pub = createPublicClient({ chain, transport: http(rpc, { retryCount: 0, timeout: 1000 }) });
      await ready(node, async () => (await pub.getChainId()) === chainId);
      const funder = privateKeyToAccount(generatePrivateKey());
      const wallet = createWalletClient({ account: funder, chain, transport: http(rpc) });
      const assets = WAVE_1B_ASSETS.filter((a) => a.network === network);
      const native = assets.find((a) => a.kind === 'native'), usdc = assets.find((a) => a.symbol === 'USDC');
      await pub.request({ method: 'hardhat_setBalance', params: [funder.address, `0x${parseEther('100').toString(16)}`] });
      await pub.request({ method: 'hardhat_setCode', params: [usdc.contract, `0x${token.evm.deployedBytecode.object}`] });
      const password = randomBytes(24).toString('hex'), key = randomBytes(24).toString('hex');
      const env = Object.fromEntries(Object.entries(process.env).filter(([name]) =>
        !/^(RPC_URL|ALCHEMY_WEBHOOK|SIGNER_|HD_|DEPOSIT_HD|SWEEP_MIN_|SECRETS_SOURCE|SSM_PATH)/.test(name)));
      Object.assign(env, {
        DATABASE_URL: url.toString(), ENVIRONMENT: 'sandbox', ALCHEMY_NETWORK: network, NETWORKS: network,
        DEFAULT_CLIENT_NETWORKS: network, RPC_URL: rpc, PORT: String(apiPort), HOST: '127.0.0.1',
        ALCHEMY_API_KEY: 'local-test-no-public-rpc', API_KEYS: key,
        COOKIE_SECURE: 'false', WORKER_ENABLED: 'false', CONFIRMATIONS: '1', RATE_LIMIT_PER_MIN: '100000',
        ORIGIN_RULE: 'off', CONSOLE_BOOTSTRAP_EMAIL: 'test@example.invalid', CONSOLE_BOOTSTRAP_PASSWORD: password,
        SWEEP_ENABLED: 'true', MIGRATE_ON_START: 'true', FIAT_LIVE_ENABLED: 'false', FIAT_MODE: 'treasury',
      });
      const signerKey = generatePrivateKey();
      env.SIGNER_PRIVATE_KEY = signerKey;
      const hotAddress = privateKeyToAccount(signerKey).address;
      server = start(['dist/server.js'], env);
      await ready(server, async () => (await fetch(`${base}/health`)).ok);
      let cookie;
      async function api(method, path, body, operator = false) {
        const response = await fetch(base + '/v1' + path, {
          method, headers: {
            'content-type': 'application/json', 'idempotency-key': randomBytes(16).toString('hex'),
            ...(operator ? { cookie, 'x-856-console': '1' } : { 'x-api-key': key }),
          }, body: body === undefined ? undefined : JSON.stringify(body),
        });
        if (path === '/auth/login') cookie = response.headers.get('set-cookie')?.split(';')[0];
        const data = await response.json();
        assert.ok(response.ok, `${method} ${path}: ${response.status} ${JSON.stringify(data)}`);
        return data;
      }
      const mine = () => pub.request({ method: 'evm_mine', params: [] });
      const tick = async () => { await mine(); await api('POST', '/worker/tick'); };
      const wait = (hash) => pub.waitForTransactionReceipt({ hash });
      await api('POST', '/auth/login', { email: 'test@example.invalid', password });
      const client = await api('POST', '/clients', { name: 'Prueba ola 1b', assets: [native.id, usdc.id] });
      await api('PATCH', `/clients/${client.id}`, { status: 'active' });
      const deposit = await api('POST', `/clients/${client.id}/deposit-address`, { network });
      const gas = parseEther('5').toString();
      await wait(await wallet.sendTransaction({ to: hotAddress, value: BigInt(gas) }));
      await api('POST', '/entries', { kind: 'adjustment', postings: [
        { account: `system:${native.id}:custody`, direction: 'debit', amount: gas },
        { account: `system:${native.id}:equity`, direction: 'credit', amount: gas },
      ] });
      const nativeHash = await wallet.sendTransaction({ to: deposit.address, value: parseEther('1') });
      await wait(nativeHash);
      await api('POST', '/deposits/report', { network, tx_hash: nativeHash });
      await wait(await wallet.writeContract({ address: usdc.contract, abi: token.abi, functionName: 'mint', args: [funder.address, 10_000_000n] }));
      const tokenHash = await wallet.writeContract({ address: usdc.contract, abi: erc20Abi, functionName: 'transfer', args: [deposit.address, 10_000_000n] });
      await wait(tokenHash);
      await api('POST', '/deposits/report', { network, tx_hash: tokenHash });
      for (let i = 0; i < 6; i++) await tick();
      const sweeps = (await api('GET', '/sweeps')).sweeps;
      for (const kind of ['sweep_native', 'sweep_token']) assert.ok(sweeps.some((s) => s.network === network && s.kind === kind && s.status === 'confirmed'), JSON.stringify(sweeps));
      const dest = privateKeyToAccount(generatePrivateKey()).address;
      await api('POST', '/wallets', { client_id: client.id, chain: 'ethereum', network, address: dest, purpose: 'withdrawal_whitelist' });
      for (const [asset, amount] of [[native, parseEther('0.2').toString()], [usdc, '4000000']]) {
        const withdrawal = await api('POST', '/withdrawals', { client_id: client.id, asset_id: asset.id, to_address: dest, amount }, true);
        for (let i = 0; i < 3; i++) await tick();
        assert.equal((await api('GET', `/withdrawals/${withdrawal.id}`)).status, 'confirmed');
      }
      assert.equal(await pub.getBalance({ address: dest }), parseEther('0.2'));
      assert.equal(await pub.readContract({ address: usdc.contract, abi: erc20Abi, functionName: 'balanceOf', args: [dest] }), 4_000_000n);
      const reconciliation = await api('GET', `/treasury/hot-wallet?network=${network}`);
      for (const asset of [native, usdc]) assert.equal(reconciliation.balances.find((b) => b.asset_id === asset.id).difference, '0');
      const fees = await scoped.query(`SELECT DISTINCT asset_id FROM postings p JOIN journal_entries e ON e.id=p.entry_id
        WHERE p.account_id IN (SELECT id FROM accounts WHERE code LIKE '%:network_fees')`);
      assert.deepEqual(fees.rows.map((r) => r.asset_id), [native.id]);
      // Reiniciar prueba idempotencia del catálogo y revalidación real de decimals() con los contratos locales.
      const before = (await scoped.query('SELECT count(*)::int AS n FROM assets')).rows[0].n;
      await stop(server);
      server = start(['dist/server.js'], env);
      await ready(server, async () => (await fetch(`${base}/health`)).ok);
      assert.equal((await scoped.query('SELECT count(*)::int AS n FROM assets')).rows[0].n, before);
      await stop(server);
      const badToken = JSON.parse(solc.compile(JSON.stringify({
        language: 'Solidity', sources: { 'LocalToken.sol': { content: source.replace('return 6;', 'return 18;') } },
        settings: { evmVersion: 'cancun', outputSelection: { '*': { '*': ['evm.deployedBytecode.object'] } } },
      }))).contracts['LocalToken.sol'].LocalToken;
      await pub.request({ method: 'hardhat_setCode', params: [usdc.contract, `0x${badToken.evm.deployedBytecode.object}`] });
      server = start(['dist/server.js'], env);
      await rejected(server, /decimals\(\) on-chain 18 no coincide con catálogo 6/);
      const otherNetwork = network === 'opt-sepolia' ? 'celo-sepolia' : 'opt-sepolia';
      server = start(['dist/server.js'], { ...env, ALCHEMY_NETWORK: otherNetwork, NETWORKS: otherNetwork });
      await rejected(server, /chainId \d+ no coincide con \d+/);
    } finally {
      await stop(server);
      await stop(node);
      await scoped.end();
      await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
    }
  });
}
