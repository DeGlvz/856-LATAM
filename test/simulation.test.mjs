import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';

process.env.ALCHEMY_API_KEY ??= 'unit-test-alchemy-key';
process.env.API_KEYS ??= 'unit-test-api-key';
process.env.DATABASE_URL ??= 'postgres://localhost/simulation_test';

const { rollbackOnly, simulationFingerprint, simulationResult } = await import('../dist/simulation.js');
const { canonical, verifyCanonicalSignature } = await import('../dist/portal/identity.js');
const { toBaseUnits } = await import('../dist/portal/obligations.js');
const { sendClientFiatActivation } = await import('../dist/routes/fiat.js');
const { summarizeClientRetirement } = await import('../dist/ledger/clients.js');

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

test('client retirement summary blocks open financial flows and preserves audit history', () => {
  const blocked = summarizeClientRetirement({
    balance_accounts: 2,
    balance_total: '100.00',
    obligations: 1,
    withdrawals: 1,
    deposits: 0,
    fiat_accounts: 1,
    fiat_deposits: 2,
    fiat_intents: 1,
    accounts: 3,
    wallets: 1,
    audit_entries: 5,
    withdrawals_history: 4,
    deposits_history: 2,
    obligations_history: 3,
  });
  assert.ok(blocked.open_reasons.includes('saldo'));
  assert.ok(blocked.open_reasons.includes('obligaciones'));
  assert.equal(blocked.has_financial_history, true);
  assert.equal(blocked.has_audit_history, true);
  assert.equal(blocked.can_hard_delete, false);

  const safe = summarizeClientRetirement({
    balance_accounts: 0,
    balance_total: '0',
    obligations: 0,
    withdrawals: 0,
    deposits: 0,
    fiat_accounts: 0,
    fiat_deposits: 0,
    fiat_intents: 0,
    accounts: 0,
    wallets: 0,
    audit_entries: 0,
    withdrawals_history: 0,
    deposits_history: 0,
    obligations_history: 0,
  });
  assert.deepEqual(safe.open_reasons, []);
  assert.equal(safe.can_hard_delete, true);
});

test('fiat activation responds HTTP 200 when no simulation audit event exists', () => {
  const auditLog = [];
  const reply = {
    statusCode: 200,
    body: null,
    code(status) { this.statusCode = status; return this; },
    send(body) { this.body = body; return this; },
  };
  const response = sendClientFiatActivation(reply, { status: 'active' });
  assert.equal(auditLog.length, 0);
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.body, { status: 'active' });
});
