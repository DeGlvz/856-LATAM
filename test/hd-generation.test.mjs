import test from 'node:test';
import assert from 'node:assert/strict';
import { mnemonicToAccount } from 'viem/accounts';

process.env.ALCHEMY_API_KEY ??= 'unit-test-alchemy-key';
process.env.API_KEYS ??= 'unit-test-api-key';
process.env.DATABASE_URL ??= 'postgres://localhost/hdgen_test';
process.env.ENVIRONMENT = 'sandbox';
process.env.ALCHEMY_NETWORK = 'eth-sepolia';
process.env.HD_GENERATION = '2';
process.env.HD_MNEMONIC = 'test test test test test test test test test test test junk'; // mnemónico público de pruebas
process.env.SIGNER_PRIVATE_KEY = '0x4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318';

const { pool } = await import('../dist/db.js');
const { getOrCreateDepositAddress } = await import('../dist/ledger/deposit-addresses.js');
const { sweepStep } = await import('../dist/ledger/sweeps.js');
const { primaryNet } = await import('../dist/chain/networks.js');

const queries = [];
const fakeResult = (sql, params) => {
  queries.push({ sql, params });
  if (/FROM clients/.test(sql)) return { rows: [{}], rowCount: 1 };
  if (/FROM client_assets/.test(sql)) return { rows: [{}], rowCount: 1 };
  if (/nextval/.test(sql)) return { rows: [{ i: 7 }], rowCount: 1 };
  if (/INSERT INTO wallets/.test(sql)) return { rows: [{ id: 'w1', address: params[2], derivation_index: params[5], webhook_registered: true }], rowCount: 1 };
  if (/kind = 'native'/.test(sql)) return { rows: [{ id: 'ETH-SEPOLIA' }], rowCount: 1 };
  return { rows: [], rowCount: 0 };
};
pool.query = async (sql, params) => fakeResult(sql, params);
pool.connect = async () => ({ query: async (sql, params) => fakeResult(sql, params), release: () => {} });

test('dirección nueva: solo se busca la generación vigente y se deriva/guarda con ella', async () => {
  const r = await getOrCreateDepositAddress('c1', false, primaryNet.id);
  const lookups = queries.filter((q) => /FROM wallets/.test(q.sql));
  assert.ok(lookups.length >= 2);
  for (const q of lookups) {
    assert.match(q.sql, /hd_generation = \$3/);
    assert.equal(q.params[2], 2);
  }
  const ins = queries.find((q) => /INSERT INTO wallets/.test(q.sql));
  assert.match(ins.sql, /hd_generation/);
  assert.equal(ins.params.at(-1), 2);
  assert.equal(r.address, mnemonicToAccount(process.env.HD_MNEMONIC, { addressIndex: 7 }).address.toLowerCase());
});

test('barrido: solo direcciones de la generación vigente', async () => {
  queries.length = 0;
  await sweepStep(primaryNet, { info() {}, warn() {} }, '00000000-0000-4000-8000-000000000001');
  const q = queries.find((x) => /FROM wallets w/.test(x.sql));
  assert.ok(q, 'se consultó la lista de direcciones a barrer');
  assert.match(q.sql, /w\.hd_generation = \$3/);
  assert.equal(q.params[2], 2);
  assert.match(q.sql, /w\.client_id IS NOT DISTINCT FROM \$2::uuid/);
  assert.equal(q.params[1], '00000000-0000-4000-8000-000000000001');
});
