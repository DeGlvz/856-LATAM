import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { privateKeyToAccount } from 'viem/accounts';
import {
  hashMessage, hexToBytes, keccak256, recoverAddress, recoverMessageAddress, recoverTransactionAddress,
  parseTransaction, serializeTransaction, parseGwei, parseEther, bytesToHex,
} from 'viem';
import { secp256k1 } from '@noble/curves/secp256k1';

process.env.ALCHEMY_API_KEY ??= 'unit-test-alchemy-key';
process.env.API_KEYS ??= 'unit-test-api-key';
process.env.DATABASE_URL ??= 'postgres://localhost/kms_test';

const { KmsSigner, parseDerSignature } = await import('../dist/chain/kms-signer.js');

// Llave de prueba pública (no es un secreto): vive solo en este doble de KMS
const PRIV = '0x4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318';
const account = privateKeyToAccount(PRIV);
const SPKI_PREFIX = '3056301006072a8648ce3d020106052b8104000a034200';
const pubSpki = Buffer.from(SPKI_PREFIX + bytesToHex(secp256k1.getPublicKey(PRIV.slice(2), false)).slice(2), 'hex');

/** Doble de KMS: firma el digest con la llave de prueba y devuelve DER. `forceHighS` fuerza la forma s alta. */
function fakeKms({ forceHighS = false } = {}) {
  const calls = [];
  return {
    calls,
    async send(cmd) {
      const name = cmd.constructor.name;
      calls.push({ name, input: cmd.input });
      if (name === 'GetPublicKeyCommand') return { PublicKey: new Uint8Array(pubSpki) };
      if (name === 'SignCommand') {
        assert.equal(cmd.input.MessageType, 'DIGEST');
        assert.equal(cmd.input.SigningAlgorithm, 'ECDSA_SHA_256');
        assert.equal(cmd.input.Message.length, 32);
        let sig = secp256k1.sign(cmd.input.Message, PRIV.slice(2), { lowS: false });
        if (forceHighS && sig.hasHighS() === false) sig = new secp256k1.Signature(sig.r, secp256k1.CURVE.n - sig.s, sig.recovery);
        return { Signature: sig.toDERRawBytes() };
      }
      throw new Error(`comando inesperado ${name}`);
    },
  };
}

test('la dirección sale de GetPublicKey (SPKI → keccak) y coincide con la llave', async () => {
  const kms = fakeKms();
  const s = await KmsSigner.create(kms, 'alias/test');
  assert.equal(s.address().toLowerCase(), account.address.toLowerCase());
  assert.equal(s.kind, 'kms');
  assert.equal(kms.calls[0].name, 'GetPublicKeyCommand');
});

for (const forceHighS of [false, true]) {
  test(`mensaje EIP-191 verificable con viem; s bajo (KMS devuelve s ${forceHighS ? 'alto' : 'natural'})`, async () => {
    const s = await KmsSigner.create(fakeKms({ forceHighS }), 'alias/test');
    for (const msg of ['hola', '856-LATAM prueba de propiedad', `n-${Math.random()}`]) {
      const sig = await s.signMessage(msg);
      assert.equal((await recoverMessageAddress({ message: msg, signature: sig })).toLowerCase(), account.address.toLowerCase());
      assert.ok(BigInt(`0x${sig.slice(66, 130)}`) <= secp256k1.CURVE.n >> 1n, 's debe ser bajo (EIP-2)');
      assert.ok(['1b', '1c'].includes(sig.slice(130)), 'v = 27/28');
      assert.equal(sig, await account.signMessage({ message: msg }), 'mismo resultado que la llave local (RFC6979)');
    }
  });
}

test('transacciones EIP-1559 y legacy: recuperan la dirección y igualan la firma local', async () => {
  const s = await KmsSigner.create(fakeKms({ forceHighS: true }), 'alias/test');
  const txs = [
    { type: 'eip1559', chainId: 11155111, nonce: 5, to: '0x000000000000000000000000000000000000dEaD', value: parseEther('0.01'), gas: 21000n, maxFeePerGas: parseGwei('30'), maxPriorityFeePerGas: parseGwei('2') },
    { type: 'legacy', chainId: 1, nonce: 0, to: '0x000000000000000000000000000000000000dEaD', value: 1n, gas: 21000n, gasPrice: parseGwei('10') },
  ];
  for (const tx of txs) {
    const raw = await s.signTransaction(tx);
    const parsed = parseTransaction(raw);
    assert.ok(BigInt(parsed.s) <= secp256k1.CURVE.n >> 1n);
    assert.equal((await recoverTransactionAddress({ serializedTransaction: raw })).toLowerCase(), account.address.toLowerCase());
    assert.equal(raw, await account.signTransaction(tx));
  }
});

test('DER: parsea enteros con y sin relleno', () => {
  const sig = secp256k1.sign(new Uint8Array(32).fill(7), PRIV.slice(2));
  const { r, s } = parseDerSignature(sig.toDERRawBytes());
  assert.equal(r, sig.r);
  assert.equal(s, sig.s);
  assert.throws(() => parseDerSignature(new Uint8Array([1, 2, 3])));
});

test('una llave KMS que no es secp256k1 sin comprimir se rechaza', async () => {
  const bad = { send: async () => ({ PublicKey: new Uint8Array(91).fill(1) }) };
  await assert.rejects(KmsSigner.create(bad, 'k'), /secp256k1/);
});

test('si KMS firma con otra llave, la firma no se acepta', async () => {
  const other = secp256k1.utils.randomPrivateKey();
  const kms = fakeKms();
  const send = kms.send;
  kms.send = async (cmd) => {
    if (cmd.constructor.name === 'SignCommand') return { Signature: secp256k1.sign(cmd.input.Message, other).toDERRawBytes() };
    return send(cmd);
  };
  const s = await KmsSigner.create(kms, 'k');
  await assert.rejects(s.signMessage('x'), /no recupera/);
});
