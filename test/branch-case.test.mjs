import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

const { canonicalJson, payloadHash, parseBranchCase } = await import('../dist/ledger/branch-case-core.js');

const CLIENT = '11111111-1111-4111-8111-111111111111';
const line = (o = {}) => ({ op_type: 'credit_available', asset_id: 'USDC-ETH-SEPOLIA', amount: '1000000', external_ref: 'EV-1', ...o });
const body = (o = {}) => ({ client_id: CLIENT, kind: 'fund_load', lines: [line()], ...o });

test('canonical JSON sorts keys recursively and ignores key order', () => {
  assert.equal(canonicalJson({ b: 1, a: { d: [3, { y: 1, x: 2 }], c: null } }), '{"a":{"c":null,"d":[3,{"x":2,"y":1}]},"b":1}');
  assert.equal(payloadHash({ a: 1, b: 2 }), payloadHash({ b: 2, a: 1 }));
  assert.notEqual(payloadHash({ a: 1 }), payloadHash({ a: 2 }));
  assert.equal(payloadHash({ a: 1 }), createHash('sha256').update('{"a":1}').digest('hex'));
});

test('valid case normalizes to a numbered canonical payload', () => {
  const r = parseBranchCase(body({ mandate_ref: ' M-1 ' }), 500);
  assert.equal(r.ok, true);
  assert.equal(r.payload.mandate_ref, 'M-1');
  assert.deepEqual(r.payload.lines.map((l) => l.line_no), [1]);
  assert.equal(r.payload.lines[0].counterparty_code, null);
});

test('amounts must be positive integers without decimals or floats', () => {
  for (const amount of ['0', '-5', '1.5', '01', '1e6', '', ' 10']) {
    const r = parseBranchCase(body({ lines: [line({ amount })] }), 500);
    assert.equal(r.ok, false, `amount ${amount}`);
    assert.equal(r.issues[0].linea, 1);
    assert.equal(r.issues[0].campo, 'amount');
  }
  assert.equal(parseBranchCase(body({ lines: [line({ amount: 1000 })] }), 500).ok, false);
});

test('line count is capped by the configured maximum', () => {
  const r = parseBranchCase(body({ lines: [line(), line(), line()] }), 2);
  assert.equal(r.ok, false);
  assert.equal(parseBranchCase(body({ lines: [] }), 2).ok, false);
});

test('unknown fields and bad client id are rejected', () => {
  assert.equal(parseBranchCase(body({ extra: true }), 500).ok, false);
  assert.equal(parseBranchCase(body({ client_id: 'nope' }), 500).ok, false);
  assert.equal(parseBranchCase(body({ lines: [{ ...line(), foo: 1 }] }), 500).ok, false);
});

test('per-operation shape rules', () => {
  const transfer = (o) => parseBranchCase(body({ kind: 'internal_transfer', lines: [line({ op_type: 'internal_transfer', ...o })] }), 500);
  assert.equal(transfer({}).ok, false);
  assert.equal(transfer({ from_account_ref: 'a', to_account_ref: 'a' }).ok, false);
  assert.equal(transfer({ from_account_ref: 'a', to_account_ref: 'b' }).ok, true);

  const pay = (o) => parseBranchCase(body({ kind: 'payment_order', lines: [line({ op_type: 'payment_order', ...o })] }), 500);
  assert.equal(pay({}).ok, false);
  assert.equal(pay({ counterparty_code: 'bad' }).ok, false);
  const ok = pay({ counterparty_code: ' 856-abcd-2345 ' });
  assert.equal(ok.ok, true);
  assert.equal(ok.payload.lines[0].counterparty_code, '856-ABCD-2345');
  assert.equal(pay({ counterparty_code: '856-ABCD-2345', from_account_ref: 'x' }).ok, false);
});

test('kind must match op types, mixed allows any, debit_adjustment is deferred', () => {
  assert.equal(parseBranchCase(body({ kind: 'payment_order' }), 500).ok, false);
  const mixed = parseBranchCase(body({ kind: 'mixed', lines: [line(), line({ op_type: 'payment_order', counterparty_code: '856-ABCD-2345' })] }), 500);
  assert.equal(mixed.ok, true);
  const adj = parseBranchCase(body({ kind: 'mixed', lines: [line({ op_type: 'debit_adjustment' })] }), 500);
  assert.equal(adj.ok, false);
  assert.match(adj.issues[0].motivo, /P2/);
});

test('hash is stable across body key order and changes with content', () => {
  const a = parseBranchCase({ lines: [line()], kind: 'fund_load', client_id: CLIENT }, 500);
  const b = parseBranchCase(body(), 500);
  assert.equal(payloadHash(a.payload), payloadHash(b.payload));
  const c = parseBranchCase(body({ lines: [line({ amount: '2' })] }), 500);
  assert.notEqual(payloadHash(b.payload), payloadHash(c.payload));
});

test('credit_available exige evidencia y el motivo verbal se normaliza', () => {
  const noEv = parseBranchCase(body({ lines: [line({ external_ref: undefined })] }), 500);
  assert.equal(noEv.ok, false);
  assert.equal(noEv.issues[0].campo, 'external_ref');
  const ok = parseBranchCase(body({ reason: '  instrucción verbal  ', source_account: 'system:USDC-ETH-SEPOLIA:equity' }), 500);
  assert.equal(ok.payload.verbal_reason, 'instrucción verbal');
  assert.equal(ok.payload.source_account, 'system:USDC-ETH-SEPOLIA:equity');
});
