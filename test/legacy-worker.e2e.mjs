import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { createServer as httpServer } from 'node:http';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
import { mkdtemp, appendFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import pg from 'pg';
import solc from 'solc';
import { createPublicClient, createWalletClient, http, parseEther } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { assertLocalUrl, localChain, until } from './lib/worker.mjs';

const database = process.env.DATABASE_URL;
assertLocalUrl(database);
Object.assign(process.env, {
  ALCHEMY_API_KEY: 'local-no-external-rpc', API_KEYS: 'local-e2e-key',
  ENVIRONMENT: 'sandbox', ALCHEMY_NETWORK: 'eth-sepolia', NETWORKS: 'eth-sepolia',
});
const { migrate } = await import('../dist/migrations/index.js');
const { pool } = await import('../dist/db.js');
const { MAIN_ASSETS } = await import('../dist/chain/catalog.js');
await pool.end();
const admin = new pg.Pool({ connectionString: database });
await admin.query('CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA public');
test.after(() => admin.end());
const require = createRequire(import.meta.url);
const hardhat = require.resolve('hardhat/internal/cli/cli.js');
const hardhatConfig = fileURLToPath(new URL('./lib/hardhat.config.cjs', import.meta.url));
const tokenAddress = '0x0000000000000000000000000000000000001111';
const tokenSource = `pragma solidity ^0.8.20;
contract LocalToken {
  mapping(address => uint256) public balanceOf;
  event Transfer(address indexed from, address indexed to, uint256 value);
  function decimals() external pure returns (uint8) { return DECIMALS; }
  function mint(address to, uint256 amount) external { balanceOf[to] += amount; emit Transfer(address(0), to, amount); }
  function transfer(address to, uint256 amount) external returns (bool) {
    require(balanceOf[msg.sender] >= amount);
    balanceOf[msg.sender] -= amount; balanceOf[to] += amount;
    emit Transfer(msg.sender, to, amount); return true;
  }
}`;
const contracts = new Map();
function token(decimals) {
  if (!contracts.has(decimals)) {
    const out = JSON.parse(solc.compile(JSON.stringify({
      language: 'Solidity', sources: { 'LocalToken.sol': { content: tokenSource.replace('DECIMALS', String(decimals)) } },
      settings: { evmVersion: 'cancun', outputSelection: { '*': { '*': ['abi', 'evm.deployedBytecode.object'] } } },
    })));
    assert.deepEqual((out.errors ?? []).filter((e) => e.severity === 'error'), []);
    contracts.set(decimals, out.contracts['LocalToken.sol'].LocalToken);
  }
  return contracts.get(decimals);
}
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
async function ready(proc, probe, description) {
  await until(async () => {
    assert.equal(proc.child.exitCode, null, proc.output());
    try { return await probe(); }
    catch (e) {
      if (e.name === 'TypeError' || e.name === 'HttpRequestError') return false;
      throw e;
    }
  }, description);
}
const allSuites = ['transfers', 'deposits-sweep', 'console-fase3', 'console-fase5', 'portal-fase2', 'portal-fase3', 'gas-funding', 'gas-bump', 'multired', 'm1',
  ...(existsSync(new URL('./branch-case.e2e.mjs', import.meta.url)) ? ['branch-case'] : [])];
const suites = process.env.WORKER_E2E_SUITES ? process.env.WORKER_E2E_SUITES.split(',') : allSuites;
assert.ok(suites.length && suites.every((s) => allSuites.includes(s)), 'WORKER_E2E_SUITES inválido');

test('E2E históricos con timer real, sesión interna y cadenas locales aisladas', { concurrency: 3 }, async (t) => {
  await Promise.all(suites.map((suite) => t.test(suite, { timeout: 600_000 }, async () => {
    const schema = `legacy_worker_${randomBytes(8).toString('hex')}`;
    await admin.query(`CREATE SCHEMA "${schema}"`);
    const url = new URL(database);
    url.searchParams.set('options', `-csearch_path=${schema},public`);
    const db = new pg.Pool({ connectionString: url.href });
    const directory = await mkdtemp(join(tmpdir(), '856-worker-e2e-'));
    const notifyLog = join(directory, 'notify.jsonl');
    const processes = [];
    let server, scenario, productionSchema;
    const notify = httpServer(async (req, res) => {
      let body = '';
      for await (const chunk of req) body += chunk;
      await appendFile(notifyLog, JSON.stringify({ token: req.headers['x-alchemy-token'], body: JSON.parse(body) }) + '\n');
      res.writeHead(200, { 'content-type': 'application/json' }).end('{}');
    });
    try {
      await migrate(db, () => {});
      notify.listen(0, '127.0.0.1');
      await once(notify, 'listening');
      const signer = generatePrivateKey();
      const env = Object.fromEntries(['PATH', 'SystemRoot', 'USERPROFILE', 'HOME', 'TEMP', 'TMP', 'APPDATA', 'ComSpec']
        .filter((k) => process.env[k] !== undefined).map((k) => [k, process.env[k]]));
      const apiPort = await freePort();
      Object.assign(env, {
        DATABASE_URL: url.href, BASE: `http://127.0.0.1:${apiPort}`, HOST: '127.0.0.1', PORT: String(apiPort),
        ENVIRONMENT: 'sandbox', ALCHEMY_NETWORK: 'eth-sepolia',
        NETWORKS: suite === 'multired' ? 'eth-sepolia,base-sepolia' : 'eth-sepolia',
        ALCHEMY_API_KEY: 'local-no-external-rpc', API_KEYS: 'local-e2e-key', KEY: 'local-e2e-key',
        SIGNER_PRIVATE_KEY: signer, SIGNER_PK: signer,
        TOKEN: tokenAddress, COOKIE_SECURE: 'false', WORKER_ENABLED: 'true', WORKER_INTERVAL_MS: '1000',
        CONFIRMATIONS: ['transfers', 'deposits-sweep', 'portal-fase2'].includes(suite) ? '3' : '1',
        ORIGIN_RULE: suite === 'portal-fase3' ? 'enforce' : 'off',
        SWEEP_ENABLED: ['transfers', 'multired', 'portal-fase2', 'portal-fase3', 'gas-bump', 'console-fase5'].includes(suite) ? 'false' : 'true',
        GAS_BUMP_AFTER_SEC: suite === 'gas-bump' ? '10' : '120',
        TOTP_ENCRYPTION_KEY: 'local-test-worker-encryption-not-a-secret', RATE_LIMIT_PER_MIN: '100000',
        MIGRATE_ON_START: 'true', FIAT_LIVE_ENABLED: 'false',
        CONSOLE_BOOTSTRAP_EMAIL: 'bootstrap@example.invalid', CONSOLE_BOOTSTRAP_PASSWORD: 'local-bootstrap-password-123',
        BOOT_EMAIL: 'bootstrap@example.invalid', BOOT_PASS: 'local-bootstrap-password-123',
        ALCHEMY_NOTIFY_URL: `http://127.0.0.1:${notify.address().port}`, ALCHEMY_NOTIFY_TOKEN: 'tok_test',
        ALCHEMY_WEBHOOK_ID: 'wh_test', ALCHEMY_WEBHOOK_SIGNING_KEY: 'local-wh-a',
        ALCHEMY_WEBHOOK_SIGNING_KEY_BASE_SEPOLIA: 'local-wh-b', NOTIFY_LOG: notifyLog,
        SWEEP_MIN_TUSD_M1: '500000000',
        ...(suite === 'branch-case' ? { BRANCH_CREDIT_ENABLED: 'true', BRANCH_CLIENT_SIGN_REQUIRED: 'false' } : {}),
      });
      const funderKey = generatePrivateKey();
      const fundedAccount = privateKeyToAccount(funderKey);
      env.FUNDER_PK = funderKey;
      const prodRpcs = {};
      const chainIds = { 'eth-sepolia': 11155111, 'base-sepolia': 84532, 'eth-mainnet': 1, 'base-mainnet': 8453, 'arb-mainnet': 42161, 'bnb-mainnet': 56 };
      const localNetworks = [...env.NETWORKS.split(','), ...(suite === 'm1' ? ['eth-mainnet', 'base-mainnet', 'arb-mainnet', 'bnb-mainnet'] : [])];
      for (const network of localNetworks) {
        const port = await freePort(), rpc = `http://127.0.0.1:${port}`;
        const node = start([hardhat, 'node', '--config', hardhatConfig, '--hostname', '127.0.0.1', '--port', String(port)], {
          ...env, LOCAL_CHAIN_ID: String(chainIds[network]),
        });
        processes.push(node);
        const pub = createPublicClient({ transport: http(rpc, { retryCount: 0, timeout: 1000 }) });
        await ready(node, () => pub.getChainId(), `${suite}: RPC ${network}`);
        const chain = await localChain(rpc, network);
        const wallet = createWalletClient({ account: fundedAccount, chain, transport: http(rpc) });
        await pub.request({ method: 'hardhat_setBalance', params: [fundedAccount.address, `0x${parseEther('1000').toString(16)}`] });
        await pub.request({ method: 'hardhat_setBalance', params: [privateKeyToAccount(signer).address, `0x${parseEther('20').toString(16)}`] });
        const assets = (await db.query(`SELECT contract_address, decimals FROM assets WHERE kind = 'erc20' AND network = $1`, [network])).rows;
        assets.push(...MAIN_ASSETS.filter((a) => a.network === network && a.contract).map((a) => ({ contract_address: a.contract, decimals: a.decimals })));
        assets.push({ contract_address: tokenAddress, decimals: 6 });
        for (const asset of assets) {
          const code = token(Number(asset.decimals));
          await pub.request({ method: 'hardhat_setCode', params: [asset.contract_address, `0x${code.evm.deployedBytecode.object}`] });
        }
        const h = await wallet.writeContract({ address: tokenAddress, abi: token(6).abi, functionName: 'mint', args: [fundedAccount.address, 1_000_000_000_000n] });
        await pub.waitForTransactionReceipt({ hash: h });
        if (network.endsWith('mainnet')) prodRpcs[network] = rpc;
        else {
          env[`RPC_URL_${network.toUpperCase().replaceAll('-', '_')}`] = rpc;
          if (network === 'eth-sepolia') env.RPC_URL = rpc;
          else env.RPC_B = rpc;
        }
      }
      if (suite === 'm1') {
        productionSchema = schema + '_prod';
        await admin.query(`CREATE SCHEMA "${productionSchema}"`);
        const productionUrl = new URL(database);
        productionUrl.searchParams.set('options', `-csearch_path=${productionSchema},public`);
        env.PROD_DB = productionUrl.href;
        env.PROD_LOCAL_RPC_URLS = JSON.stringify(prodRpcs);
      }
      server = start(['dist/server.js'], env);
      await ready(server, async () => (await fetch(env.BASE + '/health')).ok, `${suite}: API`);
      scenario = start([`test/${suite}.e2e.mjs`], env);
      const [code] = await once(scenario.child, 'exit');
      assert.equal(code, 0, `${scenario.output()}\nAPI (últimos eventos):\n${server.output().slice(-12000)}`);
      t.diagnostic(`${suite}: ${scenario.output().trim().split('\n').at(-1)}`);
      if (suite === 'branch-case') {
        scenario = start(['test/branch-case-service.e2e.mjs'], {
          ...env, ORIGIN_RULE: 'enforce', BRANCH_CLIENT_SIGN_REQUIRED: 'true', BRANCH_APPROVAL_REQUIRE_2FA: 'false',
        });
        const [serviceCode] = await once(scenario.child, 'exit');
        assert.equal(serviceCode, 0, scenario.output());
        t.diagnostic(`branch-case-service: ${scenario.output().trim().split('\n').at(-1)}`);
      }
    } finally {
      await stop(scenario);
      await stop(server);
      for (const proc of processes) await stop(proc);
      if (notify.listening) await new Promise((resolve, reject) => notify.close((error) => error ? reject(error) : resolve()));
      await db.end();
      await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
      if (productionSchema) await admin.query(`DROP SCHEMA "${productionSchema}" CASCADE`);
      await rm(directory, { recursive: true });
    }
  })));
});
