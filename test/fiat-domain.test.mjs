import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';

process.env.ALCHEMY_API_KEY ??= 'unit-test-alchemy-key';
process.env.API_KEYS ??= 'unit-test-api-key';
process.env.DATABASE_URL ??= 'postgres://localhost/fiat_test';
process.env.ENVIRONMENT = 'sandbox';
process.env.ALCHEMY_NETWORK = 'eth-sepolia';
process.env.NETWORKS = 'base-sepolia';
process.env.FIAT_MODE = 'per_client';

const { fiatIdempotencyKey, toFiatTransactionStatus } = await import('../dist/fiat/domain.js');
const { getFiatProvider, parseStandardWebhook } = await import('../dist/fiat/provider.js');
const { configErrors } = await import('../dist/environment.js');

test('fiat idempotency key binds provider, external transaction and client', () => {
  const a = fiatIdempotencyKey('monerium', 'order-42', 'client-a');
  assert.equal(a.length, 64);
  assert.notEqual(a, fiatIdempotencyKey('mock', 'order-42', 'client-a'));
  assert.notEqual(a, fiatIdempotencyKey('monerium', 'order-42', 'client-b'));
  assert.equal(a, fiatIdempotencyKey('monerium', 'order-42', 'client-a'));
});

test('provider lifecycle maps to the domain transaction state machine', () => {
  assert.equal(toFiatTransactionStatus('received'), 'CREATED');
  assert.equal(toFiatTransactionStatus('minted'), 'PROCESSING');
  assert.equal(toFiatTransactionStatus('reconciled'), 'SETTLED');
  assert.equal(toFiatTransactionStatus('released'), 'SETTLED');
  assert.equal(toFiatTransactionStatus('rejected'), 'FAILED');
  assert.equal(toFiatTransactionStatus('review'), 'FAILED');
});

test('providers without a documented API fail explicitly instead of simulating', () => {
  for (const provider of ['circle']) {
    assert.throws(() => getFiatProvider(provider), { code: 'provider_not_supported', statusCode: 501 });
  }
});

test('per_client sandbox mode passes startup configuration validation', () => {
  assert.deepEqual(configErrors(), []);
});

test('Standard Webhooks verifies signatures and rejects invalid or stale events', () => {
  const secret = 'whsec_dGVzdC1zZWNyZXQ=';
  const id = 'evt-test-1';
  const timestamp = String(Math.floor(Date.now() / 1000));
  const body = JSON.stringify({ data: { id: 'order-42' } });
  const signature = createHmac('sha256', Buffer.from(secret.slice(6), 'base64'))
    .update(`${id}.${timestamp}.${body}`)
    .digest('base64');
  const headers = { 'webhook-id': id, 'webhook-timestamp': timestamp, 'webhook-signature': `v1,${signature}` };
  assert.deepEqual(parseStandardWebhook(headers, body, secret), { verified: true, order_ids: ['order-42'] });
  assert.throws(() => parseStandardWebhook({ ...headers, 'webhook-signature': 'v1,invalid' }, body, secret), { code: 'bad_signature' });
  const stale = String(Number(timestamp) - 600);
  assert.throws(() => parseStandardWebhook({
    ...headers, 'webhook-timestamp': stale,
    'webhook-signature': `v1,${createHmac('sha256', Buffer.from(secret.slice(6), 'base64')).update(`${id}.${stale}.${body}`).digest('base64')}`,
  }, body, secret), { code: 'bad_signature' });
});
