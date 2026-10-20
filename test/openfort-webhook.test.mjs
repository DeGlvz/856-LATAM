import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';

process.env.ALCHEMY_API_KEY ??= 'unit-test-alchemy-key';
process.env.API_KEYS ??= 'unit-test-api-key';
process.env.DATABASE_URL ??= 'postgres://localhost/openfort_test';
process.env.ENVIRONMENT = 'sandbox';
process.env.ALCHEMY_NETWORK = 'eth-sepolia';

const { verifySignature, parseEvent, extractTxHashes } = await import('../dist/openfort/webhook.js');
const { config } = await import('../dist/config.js');

const secret = 'whsec_unit_test';
const body = JSON.stringify({ type: 'transaction_intent.successful', date: 1689869074, data: { id: 'tin_1' } });
const sign = (raw, s = secret) => createHmac('sha256', s).update(raw, 'utf8').digest('hex');

test('openfort is disabled by default', () => {
  assert.equal(config.OPENFORT_ENABLED, false);
});

test('valid signature is accepted, tampering and wrong secrets are rejected', () => {
  assert.equal(verifySignature(body, sign(body), secret), true);
  assert.equal(verifySignature(body, sign(body).toUpperCase(), secret), true);
  assert.equal(verifySignature(body + ' ', sign(body), secret), false);
  assert.equal(verifySignature(body, sign(body, 'otra'), secret), false);
  assert.equal(verifySignature(body, undefined, secret), false);
  assert.equal(verifySignature(body, '', secret), false);
  assert.equal(verifySignature(body, 'abc', secret), false);
  assert.equal(verifySignature(body, sign(body), ''), false);
});

test('events are parsed defensively', () => {
  assert.deepEqual(parseEvent(body), { type: 'transaction_intent.successful', date: 1689869074, data: { id: 'tin_1' } });
  assert.equal(parseEvent('no json'), null);
  assert.equal(parseEvent('[]'), null);
  assert.equal(parseEvent('{"data":{}}'), null);
});

test('transaction hashes are extracted, lowercased and de-duplicated', () => {
  const h = '0x' + 'AB'.repeat(32);
  const got = extractTxHashes({ response: { transactionHash: h }, logs: [{ hash: h.toLowerCase() }, { hash: '0x123' }] });
  assert.deepEqual(got, [h.toLowerCase()]);
  assert.deepEqual(extractTxHashes(null), []);
});
