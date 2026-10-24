import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import Fastify from 'fastify';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

const database = process.env.WORKER_TEST_DATABASE_URL;
if (!database) throw new Error('Defina WORKER_TEST_DATABASE_URL para una base PostgreSQL LOCAL de pruebas');
const dbUrl = new URL(database);
if (!['localhost', '127.0.0.1', '[::1]'].includes(dbUrl.hostname)) throw new Error('Esta prueba solo acepta PostgreSQL local');
const schema = `worker_test_${randomUUID().replaceAll('-', '')}`;
const admin = new pg.Pool({ connectionString: database });
const options = new URL(database);
options.searchParams.set('options', `-csearch_path=${schema},public`);
Object.assign(process.env, {
  DATABASE_URL: options.href, ALCHEMY_API_KEY: 'local-worker-test-not-a-secret', API_KEYS: 'local-test-api-key',
  ENVIRONMENT: 'sandbox', ALCHEMY_NETWORK: 'eth-sepolia', NETWORKS: 'eth-sepolia,base-sepolia',
  RPC_URL: 'http://127.0.0.1:1', RPC_URL_BASE_SEPOLIA: 'http://127.0.0.1:1',
  WORKER_ENABLED: 'true', GAS_BUMP_ENABLED: 'false', FIAT_LIVE_ENABLED: 'false',
  TOTP_ENCRYPTION_KEY: 'local-worker-test-encryption-key-only',
  SIGNER_PRIVATE_KEY: '0x4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318',
  HD_MNEMONIC: 'test test test test test test test test test test test junk',
  ALCHEMY_NOTIFY_TOKEN: 'test-notify-token', HD_GENERATION: '1',
});
const { pool, tx } = await import('../dist/db.js');
const { migrate } = await import('../dist/migrations/index.js');
const { networks, verifyNetworks } = await import('../dist/chain/networks.js');
const { config } = await import('../dist/config.js');
const { getDepositKeyring } = await import('../dist/chain/signer.js');
const { postEntryIn, openClientAccount, ensureAllSystemAccounts } = await import('../dist/ledger/service.js');
const { requestWithdrawal } = await import('../dist/ledger/transfers.js');
const { runWorkerClient, saveWorkerPolicy, workerClient, workerTick } = await import('../dist/ledger/worker.js');
const { WorkerPolicyInput, currentSlot } = await import('../dist/ledger/worker-schedule.js');
const { workerRoutes } = await import('../dist/routes/worker.js');
const { codeAt, currentStep, encryptSecret, generateSecret } = await import('../dist/auth/totp.js');
const log = { info() {}, warn() {}, error() {} };
const balances = new Map();
const requests = [];
const originalFetch = globalThis.fetch;
let failNotify = false;
globalThis.fetch = async (url, init) => {
  assert.equal(url, config.ALCHEMY_NOTIFY_URL, 'no external requests are allowed');
  requests.push(JSON.parse(init.body));
  return new Response(failNotify ? 'test failure' : '{}', { status: failNotify ? 503 : 200 });
};
for (const n of networks) {
  n.client.getChainId = async () => n.id === 'eth-sepolia' ? 11155111 : 84532;
  n.webhookId = `test-${n.id}`;
  n.client.getTransactionCount = async () => 0;
  n.client.estimateGas = async () => 21000n;
  n.client.estimateFeesPerGas = async () => ({ maxFeePerGas: 10n, maxPriorityFeePerGas: 1n });
  n.client.getBalance = async ({ address }) => balances.get(`${n.id}:${address.toLowerCase()}`) ?? 0n;
  n.client.getBlockNumber = async () => 100n;
  n.client.sendRawTransaction = async () => `0x${'a'.repeat(64)}`;
  n.client.getTransactionReceipt = async () => { throw new Error('not mined'); };
}
await verifyNetworks(log);
assert.ok(networks.every((n) => n.healthy), 'RPC simulados verificados antes de ejecutar');
const policy = (mode, extra = {}) => WorkerPolicyInput.parse({ mode, ...extra });
let op, c1, c2;
const walletRows = [];
const target = '0x0000000000000000000000000000000000000001';
const targetFor = (clientId) => clientId === c1 ? target : '0x0000000000000000000000000000000000000002';
async function createWithdrawal(clientId, assetId = 'ETH-SEPOLIA', extra = {}) {
  return requestWithdrawal({
    client_id: clientId, asset_id: assetId, to_address: targetFor(clientId), amount: '1000000',
    requested_by_operator: op.id, requested_by: op.email, ...extra,
  });
}
async function status(id) {
  return (await pool.query('SELECT status FROM withdrawals WHERE id = $1', [id])).rows[0].status;
}
async function save(clientId, mode, extra) {
  const { policy: old } = await workerClient(clientId);
  return saveWorkerPolicy(clientId, policy(mode, extra), old.revision, op);
}

test('worker policies, real PostgreSQL claims, isolated initiation and critical maintenance', async (t) => {
  await admin.query(`CREATE SCHEMA "${schema}"`);
  try {
    await migrate(pool, () => {});
    await migrate(pool, () => {}); // applied migration survives restarts
    await ensureAllSystemAccounts();
    op = (await pool.query(`INSERT INTO operators (email,name,password_hash,role) VALUES ('worker@example.test','Worker','unused','ejecutivo') RETURNING *`)).rows[0];
    op.totp_enabled = true;
    [c1, c2] = (await pool.query(`INSERT INTO clients(name,status) VALUES ('Worker A','active'),('Worker B','active') RETURNING id`)).rows.map((r) => r.id);
    for (const clientId of [c1, c2]) {
      for (const assetId of ['ETH-SEPOLIA', 'ETH-BASE-SEPOLIA']) {
        await pool.query(`INSERT INTO client_assets(client_id,asset_id,status) VALUES ($1,$2,'enabled')`, [clientId, assetId]);
        const acc = await tx((c) => openClientAccount(c, clientId, assetId));
        await tx((c) => postEntryIn(c, { kind: 'deposit', postings: [
          { account: `system:${assetId}:custody`, direction: 'debit', amount: '1000000000000000000' },
          { account: acc.id, direction: 'credit', amount: '1000000000000000000' },
        ] }));
        const network = assetId === 'ETH-SEPOLIA' ? 'eth-sepolia' : 'base-sepolia';
        const index = clientId === c1 ? 7 : 8;
        walletRows.push((await pool.query(
          `INSERT INTO wallets(client_id,chain,network,address,purpose,derivation_index,hd_generation)
           VALUES ($1,'ethereum',$2,$3,'deposit',$4,1) RETURNING *`,
          [clientId, network, getDepositKeyring().derive(index).address().toLowerCase(), index])).rows[0]);
        await pool.query(`INSERT INTO wallets(client_id,chain,network,address,purpose,wl_status,active_from)
          VALUES ($1,'ethereum',$2,$3,'withdrawal_whitelist','active',now())`, [clientId, network, targetFor(clientId)]);
      }
    }

    await t.test('existing and new clients without a policy are manual, no scheduled initiation', async () => {
      const view = await workerClient(c1);
      assert.equal(view.policy.mode, 'manual');
      assert.equal(view.policy.revision, 0);
      const w = await createWithdrawal(c1);
      await workerTick(log);
      assert.equal(await status(w.id), 'reserved');
      assert.equal((await workerClient(c1)).runs.length, 0);
      assert.equal(requests.filter((r) => r.addresses_to_add.includes(walletRows[0].address)).length, 0);
    });

    await t.test('a manual run only signs/registers/scans the chosen client across its enabled networks', async () => {
      const a = await createWithdrawal(c1, 'ETH-BASE-SEPOLIA');
      const other = await createWithdrawal(c2);
      const pending = await createWithdrawal(c1, 'ETH-SEPOLIA', { needs_approval: true });
      const id = randomUUID();
      const result = await runWorkerClient(c1, id, op, log);
      assert.equal(result.status, 'ok');
      assert.deepEqual(Object.keys(result.networks).sort(), ['base-sepolia', 'eth-sepolia']);
      assert.equal(await status(a.id), 'signed');
      assert.equal(await status(other.id), 'reserved');
      assert.equal(await status(pending.id), 'reserved', 'approval gate preserved');
      assert.ok(requests.length >= 2);
      assert.ok(requests.every((r) => r.addresses_to_add.every((address) => walletRows.some((w) => w.client_id === c1 && w.address === address))));
      assert.equal((await workerClient(c1)).policy.mode, 'manual');
      assert.equal((await workerClient(c1)).policy.next_due_at, null);
      assert.equal((await runWorkerClient(c1, id, op, log)).id, result.id, 'same request does not execute twice');
      assert.equal((await workerClient(c1)).usage.reduce((n, u) => n + Number(u.qty), 0), 1);
    });

    await t.test('manual client cannot sweep another client or an unenabled network', async () => {
      for (const w of walletRows) balances.set(`${w.network}:${w.address}`, 10000000000000000n);
      await pool.query(`DELETE FROM client_assets WHERE client_id = $1 AND asset_id = 'ETH-BASE-SEPOLIA'`, [c1]);
      await runWorkerClient(c1, randomUUID(), op, log);
      const sweeps = (await pool.query('SELECT s.network,w.client_id FROM sweeps s JOIN wallets w ON w.id = s.wallet_id')).rows;
      assert.ok(sweeps.length > 0);
      assert.ok(sweeps.every((s) => s.client_id === c1 && s.network === 'eth-sepolia'));
      balances.clear();
      await pool.query(`INSERT INTO client_assets(client_id,asset_id,status) VALUES ($1,'ETH-BASE-SEPOLIA','enabled')`, [c1]);
    });

    await t.test('mode changes keep already signed withdrawals and sweeps progressing globally', async () => {
      await save(c1, 'manual');
      const sweepEnabled = config.SWEEP_ENABLED;
      config.SWEEP_ENABLED = false;
      await workerTick(log);
      assert.ok((await pool.query(`SELECT 1 FROM withdrawals WHERE client_id = $1 AND status = 'broadcast'`, [c1])).rowCount);
      assert.ok((await pool.query(`SELECT 1 FROM sweeps WHERE status = 'broadcast'`)).rowCount);
      for (const n of networks) n.client.getTransactionReceipt = async () => ({
        status: 'success', blockNumber: 1n, gasUsed: 21000n, effectiveGasPrice: 1n,
      });
      const depositWallet = walletRows.find((w) => w.client_id === c2 && w.network === 'eth-sepolia');
      const hash = `0x${'b'.repeat(64)}`;
      await pool.query(
        `INSERT INTO deposits(tx_hash,log_index,wallet_id,client_id,asset_id,amount,block_number,network)
         VALUES ($1,-1,$2,$3,'ETH-SEPOLIA',1000,1,'eth-sepolia')`, [hash, depositWallet.id, c2]);
      await workerTick(log);
      assert.equal((await pool.query(`SELECT count(*)::int n FROM withdrawals WHERE status IN ('signed','broadcast')`)).rows[0].n, 0);
      assert.equal((await pool.query(`SELECT count(*)::int n FROM sweeps WHERE status IN ('signed','broadcast')`)).rows[0].n, 0);
      assert.equal((await pool.query('SELECT status FROM deposits WHERE tx_hash=$1', [hash])).rows[0].status, 'credited', 'manual clients still receive confirmed deposits');
      const before = (await pool.query('SELECT count(*)::int n FROM journal_entries')).rows[0].n;
      await workerTick(log);
      assert.equal((await pool.query('SELECT count(*)::int n FROM journal_entries')).rows[0].n, before, 'settlement is idempotent');
      for (const n of networks) n.client.getTransactionReceipt = async () => { throw new Error('not mined'); };
      config.SWEEP_ENABLED = sweepEnabled;
    });

    await t.test('automatic enables at 24h, custom interval persists and missed intervals produce only one run', async () => {
      const p = (await save(c1, 'automatic')).policy;
      assert.equal(p.interval_minutes, 1440);
      assert.ok(p.next_due_at.getTime() - Date.now() > 86390_000);
      await save(c1, 'automatic', { interval_minutes: 17 });
      assert.equal((await workerClient(c1)).policy.interval_minutes, 17);
      const before = (await workerClient(c1)).runs.length;
      await pool.query(`UPDATE worker_policies SET next_due_at = now() - interval '5 days' WHERE client_id = $1`, [c1]);
      await workerTick(log);
      await workerTick(log);
      assert.equal((await workerClient(c1)).runs.length, before + 1);
      assert.ok((await workerClient(c1)).policy.next_due_at.getTime() > Date.now() + 16 * 60000);
    });

    await t.test('UTC scheduled windows are persisted, claimed once and changing to manual cancels due work', async () => {
      const now = new Date();
      const start = '00:00', end = '24:00';
      const p = policy('scheduled', { windows: [{ days: [0, 1, 2, 3, 4, 5, 6], start, end }] });
      await save(c1, 'scheduled', { windows: p.windows });
      await pool.query(`UPDATE worker_policies SET next_due_at=now()-interval '1 minute',last_slot=NULL WHERE client_id=$1`, [c1]);
      const before = (await workerClient(c1)).runs.length;
      await workerTick(log);
      await workerTick(log);
      const active = currentSlot(p, now);
      assert.equal((await workerClient(c1)).runs.length, before + (active ? 1 : 0));
      if (active) assert.equal((await workerClient(c1)).policy.last_slot, active);
      await save(c1, 'manual');
      assert.equal((await workerClient(c1)).policy.next_due_at, null);
      const count = (await workerClient(c1)).runs.length;
      await workerTick(log);
      assert.equal((await workerClient(c1)).runs.length, count);
    });

    await t.test('independent database lock holders block parallel replicas, runs and mode changes', async () => {
      const lock = await pool.connect();
      await lock.query('SELECT pg_advisory_lock(856003)');
      try {
        await assert.rejects(runWorkerClient(c1, randomUUID(), op, log), { code: 'worker_busy' });
        await assert.rejects(workerTick(log), { code: 'worker_busy' });
        await assert.rejects(save(c1, 'automatic'), { code: 'worker_busy' });
      } finally { await lock.query('SELECT pg_advisory_unlock(856003)'); lock.release(); }
      const w = await createWithdrawal(c1);
      const estimate = networks[0].client.estimateGas;
      let entered;
      const entering = new Promise((resolve) => { entered = resolve; });
      let release;
      const waiting = new Promise((resolve) => { release = resolve; });
      networks[0].client.estimateGas = async () => { entered(); await waiting; return 21000n; };
      const run = runWorkerClient(c1, randomUUID(), op, log);
      await entering;
      assert.equal((await workerClient(c1)).runs[0].status, 'running');
      await assert.rejects(runWorkerClient(c1, randomUUID(), op, log), { code: 'worker_busy' });
      release();
      await run;
      networks[0].client.estimateGas = estimate;
      assert.equal(await status(w.id), 'signed');
    });

    await t.test('fresh processes see the persisted policy and cannot acquire an occupied worker lock', async () => {
      const lock = await pool.connect();
      await lock.query('SELECT pg_advisory_lock(856003)');
      // Use URLs derived from import.meta.url so Windows drive letters remain valid.
      const moduleUrl = new URL('../dist/ledger/worker.js', import.meta.url).href;
      const dbModule = new URL('../dist/db.js', import.meta.url).href;
      const script = `const w=await import(${JSON.stringify(moduleUrl)}); const db=await import(${JSON.stringify(dbModule)});
        try { const d=await w.workerClient(${JSON.stringify(c1)}); if(d.policy.mode!=='manual')process.exitCode=2;
        try {await w.workerTick({});process.exitCode=3;} catch(e){if(e.code!=='worker_busy')throw e;}
        } finally {await db.pool.end();}`;
      try {
        const child = spawn(process.execPath, ['--input-type=module', '-e', script], { env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
        let errors = ''; child.stderr.on('data', (b) => { errors += b; });
        const [exit] = await once(child, 'exit');
        assert.equal(exit, 0, errors);
      } finally { await lock.query('SELECT pg_advisory_unlock(856003)'); lock.release(); }
    });

    await t.test('restart recovery marks abandoned claims interrupted, audits and postpones instead of catch-up', async () => {
      await save(c1, 'automatic', { interval_minutes: 11 });
      const id = randomUUID();
      await pool.query(`INSERT INTO worker_runs(id,client_id,trigger,policy_revision) VALUES ($1,$2,'automatic',1)`, [id, c1]);
      await pool.query(`UPDATE worker_policies SET next_due_at=now()-interval '1 day' WHERE client_id=$1`, [c1]);
      const before = (await workerClient(c1)).runs.length;
      await workerTick(log);
      const view = await workerClient(c1);
      assert.equal(view.runs.find((r) => r.id === id).status, 'interrupted');
      assert.equal(view.runs.length, before);
      assert.ok(view.policy.next_due_at.getTime() > Date.now() + 10 * 60000);
      assert.ok((await pool.query(`SELECT 1 FROM audit_log WHERE action='worker_run_interrupted' AND target=$1`, [id])).rowCount);
    });

    await t.test('explicit per-network errors are persisted, audited and counted without retry storms', async () => {
      await save(c2, 'automatic', { interval_minutes: 5 });
      failNotify = true;
      const before = (await workerClient(c2)).runs.length;
      await pool.query(`UPDATE worker_policies SET next_due_at=now()-interval '1 hour' WHERE client_id=$1`, [c2]);
      await workerTick(log);
      const view = await workerClient(c2);
      assert.equal(view.runs[0].status, 'error');
      assert.match(view.runs[0].error, /Alchemy Notify 503/);
      assert.match(view.runs[0].networks['eth-sepolia'].webhook, /error/);
      assert.ok((await pool.query(`SELECT 1 FROM audit_log WHERE action='worker_run_finished' AND target=$1 AND status=500`, [view.runs[0].id])).rowCount);
      await workerTick(log);
      assert.equal((await workerClient(c2)).runs.length, before + 1);
      failNotify = false;
    });

    await t.test('signing failures and unavailable networks cannot be reported as success', async () => {
      const w = await createWithdrawal(c1);
      const estimate = networks[0].client.estimateGas;
      networks[0].client.estimateGas = async () => { throw new Error('RPC estimate unavailable'); };
      try {
        const r = await runWorkerClient(c1, randomUUID(), op, log);
        assert.equal(r.status, 'error');
        assert.match(r.networks['eth-sepolia'].sign, /RPC estimate unavailable/);
        assert.equal(await status(w.id), 'reserved');
        assert.equal((await pool.query('SELECT attempts FROM withdrawals WHERE id=$1', [w.id])).rows[0].attempts, 1);
      } finally { networks[0].client.estimateGas = estimate; }
      networks[0].healthy = false;
      networks[0].error = 'test network offline';
      try {
        const r = await runWorkerClient(c1, randomUUID(), op, log);
        assert.equal(r.status, 'error');
        assert.match(r.networks['eth-sepolia'].network, /test network offline/);
      } finally { networks[0].healthy = true; networks[0].error = null; }
    });

    await t.test('suspended clients cannot initiate or enable scheduled work', async () => {
      await pool.query(`UPDATE clients SET status='suspended' WHERE id=$1`, [c2]);
      try {
        await assert.rejects(runWorkerClient(c2, randomUUID(), op, log), { code: 'client_not_active' });
        await assert.rejects(save(c2, 'automatic'), { code: 'client_not_active' });
        const before = (await workerClient(c2)).runs.length;
        await pool.query(`UPDATE worker_policies SET next_due_at=now()-interval '1 hour' WHERE client_id=$1`, [c2]);
        await workerTick(log);
        assert.equal((await workerClient(c2)).runs.length, before);
      } finally { await pool.query(`UPDATE clients SET status='active' WHERE id=$1`, [c2]); }
    });

    await t.test('HTTP policy flow enforces fresh TOTP, revision, UTC and scoped execution', async () => {
      const app = Fastify();
      app.addHook('onRequest', async (req) => { req.principal = { kind: 'operator', operator: op }; });
      app.setErrorHandler((err, _req, reply) => reply.code(err.statusCode ?? 500).send({ error: err.message, code: err.code }));
      await app.register(workerRoutes, { prefix: '/v1' });
      const headers = { 'x-856-console': '1' };
      const url = `/v1/console/worker/clients/${c1}`;
      const secret = generateSecret();
      await pool.query(`UPDATE operators SET totp_secret_enc=$2,totp_enabled_at=now(),totp_last_step=NULL WHERE id=$1`, [op.id, encryptSecret(secret)]);
      const old = (await workerClient(c1)).policy;
      const payload = { policy: policy('manual'), revision: old.revision, code: codeAt(secret, currentStep()) };
      try {
        assert.equal((await app.inject({ method: 'PUT', url: `${url}/policy`, headers: {}, payload })).statusCode, 403);
        const result = await app.inject({ method: 'PUT', url: `${url}/policy`, headers, payload });
        assert.equal(result.statusCode, 200, result.body);
        assert.equal(result.json().policy.mode, 'manual');
        assert.equal((await app.inject({ method: 'PUT', url: `${url}/policy`, headers, payload })).json().code, 'bad_code');
        assert.equal((await app.inject({ method: 'PUT', url: `${url}/policy`, headers, payload: { ...payload, policy: { mode: 'automatic', timezone: 'America/Mexico_City' } } })).statusCode, 400);
        await assert.rejects(saveWorkerPolicy(c1, policy('automatic'), old.revision, op), { code: 'policy_changed' });
        const run = await app.inject({ method: 'POST', url: `${url}/run`, headers, payload: { request_id: randomUUID(), code: codeAt(secret, currentStep() + 1) } });
        assert.equal(run.statusCode, 200, run.body);
        assert.equal(run.json().client_id, c1);
      } finally { await app.close(); }
    });
  } finally {
    globalThis.fetch = originalFetch;
    await pool.end();
    await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
    await admin.end();
  }
});
