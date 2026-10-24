import test from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { execFileSync } from 'node:child_process';
import { MANUAL_POLICY, WorkerPolicyInput, currentSlot, nextDue } from '../dist/ledger/worker-schedule.js';

process.env.ALCHEMY_API_KEY = 'worker-test-no-external-rpc';
process.env.API_KEYS = 'worker-test-key';
process.env.DATABASE_URL = 'postgres://localhost/unused_worker_unit_tests';
process.env.ENVIRONMENT = 'sandbox';
const { workerRoutes, workerOperator } = await import('../dist/routes/worker.js');
const { config } = await import('../dist/config.js');
const { runWorkerClient, workerTick } = await import('../dist/ledger/worker.js');
const { transferRoutes } = await import('../dist/routes/transfers.js');
const at = (s) => new Date(s);
const policy = (mode, extra = {}) => WorkerPolicyInput.parse({ mode, ...extra });
const scheduled = policy('scheduled', { windows: [{ days: [1, 2, 3, 4, 5], start: '09:00', end: '10:00' }] });

test('manual default has no programmed work; automatic defaults to a real 24 hours', () => {
  const now = at('2026-10-23T09:30:00Z');
  assert.equal(nextDue(MANUAL_POLICY, now), null);
  assert.equal(nextDue(policy('automatic'), now).toISOString(), '2026-10-24T09:30:00.000Z');
  assert.equal(nextDue(policy('automatic', { interval_minutes: 5 }), now).toISOString(), '2026-10-23T09:35:00.000Z');
  assert.equal(nextDue(policy('automatic', { interval_minutes: 525600 }), now).getTime() - now.getTime(), 525600 * 60000);
});

test('strict validation rejects unsafe intervals, non-UTC timezones and invalid windows', () => {
  for (const interval_minutes of [0, 4, 5.5, 525601, Infinity]) {
    assert.equal(WorkerPolicyInput.safeParse({ mode: 'automatic', interval_minutes }).success, false);
  }
  for (const timezone of ['America/Mexico_City', 'bad-zone', '']) {
    assert.equal(WorkerPolicyInput.safeParse({ mode: 'automatic', timezone }).success, false);
  }
  for (const windows of [[], [{ days: [], start: '09:00', end: '10:00' }],
    [{ days: [7], start: '09:00', end: '10:00' }], [{ days: [1], start: '24:00', end: '25:00' }],
    [{ days: [1], start: '23:00', end: '01:00' }],
    [{ days: [1], start: '09:00', end: '10:00' }, { days: [1], start: '09:59', end: '11:00' }]]) {
    assert.equal(WorkerPolicyInput.safeParse({ mode: 'scheduled', windows }).success, false);
  }
  assert.equal(WorkerPolicyInput.safeParse({ mode: 'manual', bypass: true }).success, false);
});

test('UTC windows execute once, exclude the end and never catch up missed days', () => {
  const inside = at('2026-10-23T09:30:11Z');
  const slot = currentSlot(scheduled, inside);
  assert.equal(slot, '2026-10-23:09:00:10:00');
  assert.equal(nextDue(scheduled, inside).toISOString(), inside.toISOString());
  assert.equal(nextDue(scheduled, inside, slot).toISOString(), '2026-10-26T09:00:00.000Z');
  assert.equal(currentSlot(scheduled, at('2026-10-23T10:00:00Z')), null);
  assert.equal(nextDue(scheduled, at('2026-10-23T10:00:00Z')).toISOString(), '2026-10-26T09:00:00.000Z');
  assert.equal(nextDue(scheduled, at('2026-10-25T09:30:00Z')).toISOString(), '2026-10-26T09:00:00.000Z');
});

test('multiple windows and weekly rollover use distinct persisted slots', () => {
  const p = policy('scheduled', { windows: [
    { days: [0], start: '00:00', end: '00:01' },
    { days: [0], start: '00:01', end: '00:02' },
  ] });
  const slot = currentSlot(p, at('2026-10-25T00:00:00Z'));
  assert.equal(nextDue(p, at('2026-10-25T00:00:30Z'), slot).toISOString(), '2026-10-25T00:01:00.000Z');
  assert.equal(nextDue(p, at('2026-10-25T00:02:00Z')).toISOString(), '2026-11-01T00:00:00.000Z');
});

test('end 24:00 covers the final minute of the UTC day without crossing into the next day', () => {
  const p = policy('scheduled', { windows: [{ days: [5], start: '23:59', end: '24:00' }] });
  const now = at('2026-10-23T23:59:59.999Z');
  assert.equal(currentSlot(p, now), '2026-10-23:23:59:24:00');
  assert.equal(nextDue(p, now).toISOString(), now.toISOString());
  assert.equal(currentSlot(p, at('2026-10-24T00:00:00Z')), null);
  assert.equal(nextDue(p, at('2026-10-24T00:00:00Z')).toISOString(), '2026-10-30T23:59:00.000Z');
});

test('only executive and treasurer session principals can control the worker', () => {
  const req = (role, method = 'POST', headers = { 'x-856-console': '1' }) => ({
    method, headers, principal: { kind: 'operator', operator: { role } },
  });
  for (const role of ['ejecutivo', 'tesorero']) assert.equal(workerOperator(req(role)).role, role);
  assert.throws(() => workerOperator(req('lectura')), { code: 'forbidden' });
  assert.throws(() => workerOperator(req('ejecutivo', 'POST', {})), { code: 'csrf' });
  for (const principal of [undefined, { kind: 'api' }, { kind: 'client_user' }, { kind: 'client_key' }, { kind: 'assist' }]) {
    assert.throws(() => workerOperator({ principal, headers: {}, method: 'GET' }), { code: 'operator_required' });
  }
});

test('all worker HTTP routes reject API keys/portal/read-only principals before database access', async () => {
  const app = Fastify();
  app.addHook('onRequest', async (req) => {
    req.principal = req.headers['x-test-principal'] === 'lectura'
      ? { kind: 'operator', operator: { role: 'lectura' } } : { kind: req.headers['x-test-principal'] ?? 'api' };
  });
  await app.register(workerRoutes, { prefix: '/v1' });
  for (const kind of ['api', 'client_user', 'client_key', 'assist', 'lectura']) {
    for (const [method, path] of [
      ['GET', ''], ['GET', '/00000000-0000-4000-8000-000000000001'],
      ['PUT', '/00000000-0000-4000-8000-000000000001/policy'],
      ['POST', '/00000000-0000-4000-8000-000000000001/run'],
    ]) {
      const r = await app.inject({ method, url: `/v1/console/worker/clients${path}`, headers: { 'x-test-principal': kind } });
      assert.equal(r.statusCode, 403, `${kind} ${method} ${path}`);
    }
  }
  await app.close();
});

test('global WORKER_ENABLED=false blocks even direct function calls without consulting the database', async () => {
  const enabled = config.WORKER_ENABLED;
  config.WORKER_ENABLED = false;
  try {
    await assert.rejects(runWorkerClient('ignored', 'ignored', {}, {}), { code: 'worker_disabled' });
    await assert.rejects(workerTick({}), { code: 'worker_disabled' });
  } finally { config.WORKER_ENABLED = enabled; }
});

test('insufficient connection pool fails explicitly rather than waiting forever on its own lock', async () => {
  const size = config.DB_POOL_MAX;
  config.DB_POOL_MAX = 1;
  try { await assert.rejects(workerTick({}), { code: 'worker_pool_size' }); }
  finally { config.DB_POOL_MAX = size; }
});

test('legacy global endpoint returns 410 without invoking work even with an API principal', async () => {
  const app = Fastify();
  app.addHook('onRequest', async (req) => { req.principal = { kind: 'api', keyId: 'test' }; });
  await app.register(transferRoutes, { prefix: '/v1' });
  const r = await app.inject({ method: 'POST', url: '/v1/worker/tick', payload: {} });
  assert.equal(r.statusCode, 410);
  assert.equal(r.json().code, 'worker_global_removed');
  await app.close();
});

test('production setupRequired blocks timer entry and internal manual execution before acquiring locks', () => {
  const moduleUrl = new URL('../dist/ledger/worker.js', import.meta.url).href;
  const dbModule = new URL('../dist/db.js', import.meta.url).href;
  const envModule = new URL('../dist/environment.js', import.meta.url).href;
  const script = `
    const assert = (await import('node:assert/strict')).default;
    const {pool}=await import(${JSON.stringify(dbModule)});
    pool.query=async sql=>({rows:[{n:sql.includes('totp_enabled_at')?0:1}]});
    pool.connect=async()=>{throw new Error('must not acquire worker lock during setup')};
    const env=await import(${JSON.stringify(envModule)});
    await env.assertTreasuryAtBoot({warn(){}});
    assert.equal(await env.setupRequired(),true);
    const worker=await import(${JSON.stringify(moduleUrl)});
    await assert.rejects(worker.workerTick({}),{code:'setup_required'});
    await assert.rejects(worker.runWorkerClient('ignored','ignored',{},{}),{code:'setup_required'});
    await pool.end();`;
  execFileSync(process.execPath, ['--input-type=module', '-e', script], {
    env: { ...process.env, ENVIRONMENT: 'production', WORKER_ENABLED: 'true' }, stdio: 'pipe',
  });
});
