import test from 'node:test';
import assert from 'node:assert/strict';

const { schemaFor, isValidClabe, isValidIban } = await import('../dist/fiat/rail-fields.js');
const ok = (type, v) => schemaFor(type).safeParse(v);
const base = { beneficiary_name: 'Titular Ficticio', bank_name: 'Banco Ficticio', bank_address: 'Calle Falsa 123, Ciudad', account_number: '000123456789' };

// Dígito verificador calculado de forma independiente (pesos 3-7-1)
const clabeFrom = (d17) => {
  const w = [3, 7, 1];
  let s = 0;
  for (let i = 0; i < 17; i++) s += (Number(d17[i]) * w[i % 3]) % 10;
  return d17 + String((10 - (s % 10)) % 10);
};

test('wire: ACH/wire doméstico con ABA y sin SWIFT', () => {
  assert.equal(ok('wire', { ...base, aba: '021000021' }).success, true);
});
test('wire: SWIFT sin ABA (ej. SSB Bank)', () => {
  assert.equal(ok('wire', { ...base, swift: 'ssbaus32', aba: '' }).success, true);
  assert.equal(ok('wire', { ...base, swift: 'SSBAUS32' }).data.swift, 'SSBAUS32');
});
test('wire internacional con intermediario opcional', () => {
  const r = ok('wire', { ...base, swift: 'FICTUS33XXX', intermediary_bank: 'Banco Intermediario Ficticio', intermediary_swift: 'INTLUS33' });
  assert.equal(r.success, true);
});
test('wire: exige SWIFT o ABA, y valida formatos', () => {
  assert.equal(ok('wire', base).success, false);
  assert.equal(ok('wire', { ...base, aba: '12345' }).success, false);
  assert.equal(ok('wire', { ...base, swift: 'ABC' }).success, false);
  assert.equal(ok('wire', { ...base, swift: '12345678' }).success, false);
});
test('wire: banco, dirección, titular y cuenta siempre requeridos', () => {
  for (const k of ['beneficiary_name', 'bank_name', 'bank_address', 'account_number']) {
    assert.equal(ok('wire', { ...base, aba: '021000021', [k]: '' }).success, false, k);
  }
});
test('ach: exige ABA y tipo de cuenta, no SWIFT', () => {
  assert.equal(ok('ach', { ...base, aba: '021000021', account_type: 'checking' }).success, true);
  assert.equal(ok('ach', { ...base, aba: '021000021', account_type: 'business_checking', account_holder_type: 'empresa' }).success, true);
  assert.equal(ok('ach', { ...base, aba: '021000021' }).success, false);
  assert.equal(ok('ach', { ...base, account_type: 'savings' }).success, false);
});
test('sepa: IBAN con checksum y BIC opcional', () => {
  assert.equal(ok('sepa', { beneficiary_name: 'Titular Ficticio', iban: 'DE89 3704 0044 0532 0130 00' }).success, true);
  assert.equal(ok('sepa', { beneficiary_name: 'Titular Ficticio', iban: 'DE89370400440532013001' }).success, false);
  assert.equal(isValidIban('DE89370400440532013000'), true);
});
test('spei: CLABE de 18 dígitos con dígito verificador', () => {
  const good = clabeFrom('01218000011234567');
  assert.equal(isValidClabe(good), true);
  assert.equal(ok('spei', { beneficiary_name: 'Titular Ficticio', clabe: good }).success, true);
  const bad = good.slice(0, 17) + String((Number(good[17]) + 1) % 10);
  assert.equal(ok('spei', { beneficiary_name: 'Titular Ficticio', clabe: bad }).success, false);
  assert.equal(ok('spei', { beneficiary_name: 'Titular Ficticio', clabe: '123' }).success, false);
});
test('pix y genérico: solo lo esencial es requerido', () => {
  assert.equal(ok('pix', { beneficiary_name: 'Titular Ficticio', pix_key: 'llave-ficticia@example.com' }).success, true);
  assert.equal(ok('generic', { beneficiary_name: 'Titular Ficticio' }).success, true);
  assert.equal(ok('generic', { bank_name: 'x' }).success, false);
});
test('tipo de titular solo persona o empresa', () => {
  assert.equal(ok('ach', { ...base, aba: '021000021', account_type: 'checking', account_holder_type: 'persona' }).success, true);
  assert.equal(ok('ach', { ...base, aba: '021000021', account_type: 'checking', account_holder_type: 'otro' }).success, false);
});
