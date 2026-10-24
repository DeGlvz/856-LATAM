import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mnemonicToAccount } from 'viem/accounts';
import { encodeFunctionData, erc20Abi, parseEther, parseGwei, recoverTransactionAddress, recoverMessageAddress } from 'viem';

process.env.ALCHEMY_API_KEY ??= 'unit-test-alchemy-key';
process.env.API_KEYS ??= 'unit-test-api-key';
process.env.DATABASE_URL ??= 'postgres://localhost/remote_test';

const { encrypt, generateSecrets, writeKeystore, decrypt, readKeystore } = await import('../dist/signer-service/keystore.js');
const { createSignerService } = await import('../dist/signer-service/server.js');
const { DailyLedger, evaluateTx, loadPolicy } = await import('../dist/signer-service/policy.js');
const { RemoteSignerClient, RemoteSigner, RemoteHdKeyring, signRequest } = await import('../dist/chain/remote-signer.js');

const SECRET = 'x'.repeat(48);
const PASS = 'contraseña-de-prueba-larga';
const USDT = '0x1111111111111111111111111111111111111111';
const LINK = 'I hereby declare that I am the address owner.';

const dir = mkdtempSync(join(tmpdir(), '856-signer-'));
const secrets = generateSecrets();
const ks = encrypt(secrets, PASS);
writeKeystore(join(dir, 'keystore.json'), ks);
writeFileSync(join(dir, 'policy.json'), JSON.stringify({
  chains: { 1: { native: { perTx: parseEther('1').toString(), perDay: parseEther('1.5').toString() }, tokens: { [USDT]: { perTx: '1000000000', perDay: '1500000000' } } } },
  messages: [LINK],
}));

const svc = createSignerService({
  keystorePath: join(dir, 'keystore.json'), policyPath: join(dir, 'policy.json'), secret: SECRET,
  ledgerPath: join(dir, 'ledger.json'), auditPath: join(dir, 'audit.jsonl'), pausePath: join(dir, 'PAUSE'),
});
await new Promise((r) => svc.api.listen(0, '127.0.0.1', r));
await new Promise((r) => svc.admin.listen(0, '127.0.0.1', r));
const apiUrl = `http://127.0.0.1:${svc.api.address().port}`;
const adminUrl = `http://127.0.0.1:${svc.admin.address().port}`;
const client = new RemoteSignerClient({ url: apiUrl, secret: SECRET });

const base = { type: 'eip1559', chainId: 1, gas: 21000n, maxFeePerGas: parseGwei('20'), maxPriorityFeePerGas: parseGwei('1') };
const RECIPIENT = '0x2222222222222222222222222222222222222222';

test.after(() => { svc.api.close(); svc.admin.close(); rmSync(dir, { recursive: true, force: true }); });

test('almacén: cifra, descifra y rechaza contraseña incorrecta', () => {
  const f = readKeystore(join(dir, 'keystore.json'));
  assert.equal(JSON.stringify(f).includes(secrets.mnemonic), false, 'la frase no aparece en claro');
  assert.equal(JSON.stringify(f).includes(secrets.hotKey.slice(2)), false, 'la llave no aparece en claro');
  assert.deepEqual(decrypt(f, PASS), secrets);
  assert.throws(() => decrypt(f, 'otra-contraseña-larga-x'), /Contraseña incorrecta/);
});

test('bloqueado: informa datos públicos pero no firma', async () => {
  const info = await client.info();
  assert.equal(info.hot, ks.hot);
  assert.equal(info.locked, true);
  const s = new RemoteSigner(client, { kind: 'hot' }, ks.hot);
  await assert.rejects(s.signTransaction({ ...base, nonce: 0, to: RECIPIENT, value: 1n }), /bloqueado/);
});

test('desbloqueo manual solo con la contraseña correcta', async () => {
  const bad = await fetch(`${adminUrl}/admin/unlock`, { method: 'POST', body: JSON.stringify({ passphrase: 'incorrecta-incorrecta' }) });
  assert.equal(bad.status, 400);
  const ok = await fetch(`${adminUrl}/admin/unlock`, { method: 'POST', body: JSON.stringify({ passphrase: PASS }) });
  assert.equal(ok.status, 200);
  assert.equal((await client.info()).locked, false);
});

test('xpub: la app deriva las mismas direcciones de depósito sin tener la semilla', async () => {
  const kr = new RemoteHdKeyring(client, ks.xpub);
  for (const i of [0, 1, 7, 1234]) {
    assert.equal(kr.derive(i).address(), mnemonicToAccount(secrets.mnemonic, { addressIndex: i }).address);
  }
});

test('hot wallet: firma dentro del tope y la firma recupera la dirección', async () => {
  const s = new RemoteSigner(client, { kind: 'hot' }, ks.hot);
  const raw = await s.signTransaction({ ...base, nonce: 0, to: RECIPIENT, value: parseEther('0.5') });
  assert.equal(await recoverTransactionAddress({ serializedTransaction: raw }), ks.hot);
});

test('hot wallet: rechaza más que el tope por transacción', async () => {
  const s = new RemoteSigner(client, { kind: 'hot' }, ks.hot);
  await assert.rejects(s.signTransaction({ ...base, nonce: 1, to: RECIPIENT, value: parseEther('1.1') }), /tope por transacción/);
});

test('tope diario: un reemplazo (mismo nonce) no cuenta doble; uno nuevo que excede se rechaza', async () => {
  const s = new RemoteSigner(client, { kind: 'hot' }, ks.hot);
  // nonce 0 ya consumió 0.5; reemplazo del nonce 0 con más comisión y el mismo monto: permitido
  await s.signTransaction({ ...base, nonce: 0, to: RECIPIENT, value: parseEther('0.5'), maxFeePerGas: parseGwei('30') });
  await s.signTransaction({ ...base, nonce: 2, to: RECIPIENT, value: parseEther('0.9') }); // total 1.4
  await assert.rejects(s.signTransaction({ ...base, nonce: 3, to: RECIPIENT, value: parseEther('0.2') }), /tope diario/);
});

test('ERC-20: solo transfer() de contratos listados, con tope propio', async () => {
  const s = new RemoteSigner(client, { kind: 'hot' }, ks.hot);
  const data = encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [RECIPIENT, 500_000_000n] });
  await s.signTransaction({ ...base, gas: 60000n, nonce: 4, to: USDT, value: 0n, data });
  const other = '0x3333333333333333333333333333333333333333';
  await assert.rejects(s.signTransaction({ ...base, gas: 60000n, nonce: 5, to: other, value: 0n, data }), /lista de tokens/);
  const approve = encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [RECIPIENT, 1n] });
  await assert.rejects(s.signTransaction({ ...base, gas: 60000n, nonce: 5, to: USDT, value: 0n, data: approve }), /solo se permite transfer/);
});

test('depósito: solo puede barrer hacia la hot wallet', async () => {
  const kr = new RemoteHdKeyring(client, ks.xpub);
  const dep = kr.derive(3);
  const toHot = encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [ks.hot, 10n ** 12n] });
  const raw = await dep.signTransaction({ ...base, gas: 60000n, nonce: 0, to: USDT, value: 0n, data: toHot });
  assert.equal(await recoverTransactionAddress({ serializedTransaction: raw }), dep.address());
  await dep.signTransaction({ ...base, nonce: 1, to: ks.hot, value: parseEther('5') }); // nativo a la hot: sin tope
  await assert.rejects(dep.signTransaction({ ...base, nonce: 2, to: RECIPIENT, value: 1n }), /solo puede enviar a la hot wallet/);
  await dep.signTransaction({ ...base, nonce: 2, to: dep.address(), value: 0n }); // cancelación
});

test('red no listada y mensajes fuera de la política se rechazan', async () => {
  const s = new RemoteSigner(client, { kind: 'hot' }, ks.hot);
  await assert.rejects(s.signTransaction({ ...base, chainId: 137, nonce: 0, to: RECIPIENT, value: 1n }), /red 137 no permitida/);
  const dep = new RemoteHdKeyring(client, ks.xpub).derive(0);
  const sig = await dep.signMessage(LINK);
  assert.equal(await recoverMessageAddress({ message: LINK, signature: sig }), dep.address());
  await assert.rejects(dep.signMessage('transfiere todo'), /mensaje no permitido/);
});

test('autenticación: HMAC incorrecto, fuera de ventana y repetido se rechazan', async () => {
  const path = '/v1/info';
  const bad = await fetch(apiUrl + path, { headers: signRequest('y'.repeat(48), 'GET', path, '') });
  assert.equal(bad.status, 401);
  const old = await fetch(apiUrl + path, { headers: signRequest(SECRET, 'GET', path, '', Math.floor(Date.now() / 1000) - 600) });
  assert.equal(old.status, 401);
  const h = signRequest(SECRET, 'GET', path, '');
  assert.equal((await fetch(apiUrl + path, { headers: h })).status, 200);
  assert.equal((await fetch(apiUrl + path, { headers: h })).status, 401, 'repetición');
});

test('pausa de emergencia: con el archivo PAUSE no se firma nada', async () => {
  writeFileSync(join(dir, 'PAUSE'), '');
  const s = new RemoteSigner(client, { kind: 'hot' }, ks.hot);
  await assert.rejects(s.signTransaction({ ...base, nonce: 9, to: RECIPIENT, value: 1n }), /pausa/);
  rmSync(join(dir, 'PAUSE'));
});

test('la app detecta si el firmante altera la transacción', async () => {
  const { assertSignedMatches } = await import('../dist/chain/remote-signer.js');
  const s = new RemoteSigner(client, { kind: 'hot' }, ks.hot);
  const { serializeTransaction } = await import('viem');
  const signed = await s.signTransaction({ ...base, nonce: 10, to: RECIPIENT, value: 0n + 1n });
  const other = serializeTransaction({ ...base, nonce: 10, to: RECIPIENT, value: 2n });
  await assert.rejects(assertSignedMatches(other, signed, ks.hot), /alteró la transacción/);
});

test('política: valores inválidos se rechazan al cargar', () => {
  writeFileSync(join(dir, 'bad.json'), JSON.stringify({ chains: { 1: { native: { perTx: '1e18', perDay: '1' }, tokens: {} } } }));
  assert.throws(() => loadPolicy(join(dir, 'bad.json')), /Límite inválido/);
  const p = loadPolicy(join(dir, 'policy.json'));
  const d = evaluateTx(p, { ref: { kind: 'hot' }, from: ks.hot, chainId: 1, nonce: 99, to: undefined, value: 0n, data: undefined }, ks.hot, new DailyLedger());
  assert.equal(d.ok, false);
});
