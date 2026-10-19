import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';

process.env.ALCHEMY_API_KEY ??= 'unit-test-alchemy-key';
process.env.API_KEYS ??= 'unit-test-api-key';
process.env.DATABASE_URL ??= 'postgres://localhost/simulation_test';

const { rollbackOnly, simulationFingerprint, simulationResult } = await import('../dist/simulation.js');
const { canonical, verifyCanonicalSignature } = await import('../dist/portal/identity.js');
const { toBaseUnits } = await import('../dist/portal/obligations.js');
const { assertRecentTemplateSimulation } = await import('../dist/fiat/service.js');

test('dry-run transaction always rolls back and never commits', async () => {
  const statements = [];
  const fake = {
    query: async (sql) => { statements.push(sql); return { rows: [] }; },
    release: () => { statements.push('RELEASE'); },
  };
  const value = await rollbackOnly(async (c) => {
    await c.query('INSERT INTO clients (name) VALUES ($1)', ['simulation']);
    return 'validated';
  }, async () => fake);
  assert.equal(value, 'validated');
  assert.deepEqual(statements, ['BEGIN', 'INSERT INTO clients (name) VALUES ($1)', 'ROLLBACK', 'RELEASE']);
  assert.equal(statements.includes('COMMIT'), false);
});

test('dry-run transaction rolls back when validation throws', async () => {
  const statements = [];
  const fake = {
    query: async (sql) => { statements.push(sql); return { rows: [] }; },
    release: () => { statements.push('RELEASE'); },
  };
  await assert.rejects(
    rollbackOnly(async () => { throw new Error('invalid template'); }, async () => fake),
    /invalid template/,
  );
  assert.deepEqual(statements, ['BEGIN', 'ROLLBACK', 'RELEASE']);
});

test('Ed25519 canonical request signature validates the exact body and rejects tampering', () => {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const rawPublicKey = publicKey.export({ format: 'jwk' }).x;
  const method = 'POST', url = '/v1/portal/obligations/import', ts = '1792375200', nonce = '0123456789abcdef';
  const body = '{"csv":"contraparte,activo,monto"}';
  const signature = sign(null, Buffer.from(canonical(method, url, ts, nonce, body)), privateKey).toString('base64url');
  assert.equal(verifyCanonicalSignature(rawPublicKey, method, url, ts, nonce, signature, body), true);
  assert.equal(verifyCanonicalSignature(rawPublicKey, method, url, ts, nonce, signature, `${body} `), false);
});

test('decimal conversion uses integer base units and rejects excess USDC precision', () => {
  assert.equal(toBaseUnits('1.000001', 6), '1000001');
  assert.equal(toBaseUnits('1.0000001', 6), null);
  assert.equal(toBaseUnits('1.000000000000000001', 18), '1000000000000000001');
  assert.equal(toBaseUnits('1.0000000000000000001', 18), null);
});

test('fingerprint is SHA-256 and simulated adapters are visibly synthetic', () => {
  const scope = { route: 'POST /v1/clients', payload: { name: 'Pilot' } };
  const fingerprint = simulationFingerprint(scope);
  assert.match(fingerprint, /^[0-9a-f]{64}$/);
  const result = simulationResult(fingerprint, { status: 'validated' });
  assert.equal(result.provider_calls, 0);
  assert.equal(result.emulation.webhook.status, 'processed');
  assert.match(result.emulation.wallet, /^0x[0-9a-f]{40}$/);
  assert.match(result.emulation.iban, /^ZZ00SIMU[A-F0-9]{12}$/);
});

test('fiat activation requires a recent per-client simulation audit event', async () => {
  let queryArgs;
  const noEvent = { query: async (_sql, args) => { queryArgs = args; return { rowCount: 0 }; } };
  await assert.rejects(
    assertRecentTemplateSimulation('client-1', noEvent),
    { code: 'simulation_required_before_production', statusCode: 422 },
  );
  assert.deepEqual(queryArgs, ['client-1']);
  const recentEvent = { query: async () => ({ rowCount: 1 }) };
  await assert.doesNotReject(assertRecentTemplateSimulation('client-1', recentEvent));
});
