// E2E gas bump: reemplazo de transacciones atascadas contra una cadena LOCAL (Hardhat/Anvil) con minado manual.
// Uso: BASE KEY RPC_URL FUNDER_PK DATABASE_URL BOOT_EMAIL BOOT_PASS node test/gas-bump.e2e.mjs
// API con COOKIE_SECURE=false, WORKER_ENABLED=false, CONFIRMATIONS=1, GAS_BUMP_AFTER_SEC=3 y firmante de prueba.
import { execFileSync } from 'node:child_process';
import pg from 'pg';
import { createPublicClient, createWalletClient, http, parseEther } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { hardhat } from 'viem/chains';

const { BASE, KEY, RPC_URL, FUNDER_PK, BOOT_EMAIL, BOOT_PASS, DATABASE_URL } = process.env;
const pub = createPublicClient({ chain: hardhat, transport: http(RPC_URL) });
const funder = createWalletClient({ account: privateKeyToAccount(FUNDER_PK), chain: hardhat, transport: http(RPC_URL) });
const ETH = 'ETH-SEPOLIA';
const R = Math.random().toString(36).slice(2, 8);
const NET = `10.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`;
let ok = 0, fail = 0;
const check = (n, got, want) => { if (String(got) === String(want)) { ok++; console.log('✔', n); } else { fail++; console.log(`✘ ${n} — esperado ${want}, obtenido ${got}`); } };
const rpc = (method, params = []) => pub.request({ method, params });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function browser(ip) {
  let cookie = null;
  const call = async (method, path, body, extra = {}) => {
    const r = await fetch(BASE + path, { method, headers: { 'x-forwarded-for': ip, ...(body ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}), ...(method !== 'GET' ? { 'x-856-console': '1' } : {}), ...extra }, body: body && JSON.stringify(body) });
    const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
    return { status: r.status, body: await r.json().catch(() => null) };
  };
  return { call, login: (e, p) => call('POST', '/v1/auth/login', { email: e, password: p }) };
}
const key = async (method, path, body, idem) => {
  const r = await fetch(BASE + path, { method, headers: { 'x-api-key': KEY, 'content-type': 'application/json', ...(idem ? { 'idempotency-key': `${idem}-${R}` } : {}) }, body: body && JSON.stringify(body) });
  return { status: r.status, body: await r.json() };
};

const tes = browser(`${NET}.1`); check('login tesorero', (await tes.login(BOOT_EMAIL, BOOT_PASS)).status, 200);
execFileSync('node', ['dist/scripts/create-operator.js', `opg-${R}@ejemplo.mx`, 'ejecutivo'], { input: 'clave-operador-123\n', env: process.env, stdio: ['pipe', 'pipe', 'ignore'] });
const opr = browser(`${NET}.2`); await opr.login(`opg-${R}@ejemplo.mx`, 'clave-operador-123');
const tick = () => tes.call('POST', '/v1/worker/tick', {});
const db = new pg.Client({ connectionString: DATABASE_URL }); await db.connect();

// ── Cliente activo con saldo y destino en lista blanca; hot wallet con gas cuadrado en el libro
const cl = (await key('POST', '/v1/clients', { name: `GB ${R}`, assets: [ETH] }, 'c')).body;
await key('PATCH', `/v1/clients/${cl.id}`, { status: 'active' });
const DEST = privateKeyToAccount(generatePrivateKey()).address;
await key('POST', '/v1/wallets', { client_id: cl.id, chain: 'ethereum', network: 'eth-sepolia', address: DEST, purpose: 'withdrawal_whitelist' });
const acc = (await key('GET', `/v1/clients/${cl.id}`)).body.accounts[0].id;
await key('POST', '/v1/entries', { kind: 'deposit', postings: [
  { account: `system:${ETH}:custody`, direction: 'debit', amount: parseEther('0.3').toString() }, { account: acc, direction: 'credit', amount: parseEther('0.3').toString() }] }, 'fund');
const hot = (await tes.call('GET', '/v1/treasury/hot-wallet')).body.address;
await pub.waitForTransactionReceipt({ hash: await funder.sendTransaction({ to: hot, value: parseEther('2') }) });
const gap = BigInt((await tes.call('GET', '/v1/treasury/hot-wallet')).body.balances.find((b) => b.asset_id === ETH).difference);
if (gap > 0n) await key('POST', '/v1/entries', { kind: 'adjustment', postings: [
  { account: `system:${ETH}:custody`, direction: 'debit', amount: gap.toString() }, { account: `system:${ETH}:equity`, direction: 'credit', amount: gap.toString() }] }, 'gap');

await rpc('evm_setAutomine', [false]);
try {
  // ═════ 1. Atascado → aceleración manual y automática → se mina el último reemplazo
  const w1 = (await key('POST', '/v1/withdrawals', { client_id: cl.id, asset_id: ETH, to_address: DEST, amount: parseEther('0.1').toString() }, 'w1')).body;
  await tick();
  let d = (await tes.call('GET', `/v1/withdrawals/${w1.id}`)).body;
  check('retiro enviado y sin minar (minado manual)', d.status, 'broadcast');
  check('  …intento original registrado', `${d.attempts_log.length} ${d.attempts_log[0].reason}`, '1 original');
  const h0 = d.tx_hash, fee0 = BigInt(d.attempts_log[0].max_fee_per_gas);

  check('operador no acelera → 403', (await opr.call('POST', `/v1/withdrawals/${w1.id}/bump`, {})).status, 403);
  const b1 = await tes.call('POST', `/v1/withdrawals/${w1.id}/bump`, {});
  check('tesorero acelera → 200 con hash nuevo', `${b1.status} ${b1.body.tx_hash !== h0}`, '200 true');
  check('  …comisión ≥ +25 %', BigInt(b1.body.max_fee_per_gas) * 100n >= fee0 * 125n, true);
  d = b1.body.withdrawal;
  check('  …retiro apunta al reemplazo (mismo nonce, bumps = 1)', `${d.tx_hash === b1.body.tx_hash} ${d.bumps}`, 'true 1');
  check('  …historial: original + manual con autor', d.attempts_log.map((a) => `${a.reason}:${a.requested_by ?? ''}`).join(','), `original:,manual:${BOOT_EMAIL.toLowerCase()}`);
  check('  …el reemplazo está en el mempool', !!(await rpc('eth_getTransactionByHash', [b1.body.tx_hash])), true);

  await sleep(3500); await tick(); // GAS_BUMP_AFTER_SEC=3
  d = (await tes.call('GET', `/v1/withdrawals/${w1.id}`)).body;
  check('el worker acelera solo tras GAS_BUMP_AFTER_SEC', `${d.bumps} ${d.attempts_log.at(-1).reason}`, '2 bump');
  const h2 = d.tx_hash;

  await rpc('evm_mine'); await tick();
  d = (await tes.call('GET', `/v1/withdrawals/${w1.id}`)).body;
  check('se mina el último reemplazo → confirmado', `${d.status} ${d.tx_hash === h2}`, 'confirmed true');
  check('  …destino recibió 0.1 ETH (una sola vez)', await pub.getBalance({ address: DEST }), parseEther('0.1').toString());
  check('  …gas registrado', BigInt(d.gas_cost_wei ?? 0) > 0n, true);
  check('  …el hash original nunca se minó', await rpc('eth_getTransactionReceipt', [h0]), null);
  check('acelerar un confirmado → 409', (await tes.call('POST', `/v1/withdrawals/${w1.id}/bump`, {})).body.code, 'not_broadcast');

  // ═════ 2. Se mina un intento ANTERIOR: la confirmación lo encuentra y adopta su hash
  const w2 = (await key('POST', '/v1/withdrawals', { client_id: cl.id, asset_id: ETH, to_address: DEST, amount: parseEther('0.05').toString() }, 'w2')).body;
  await tick();
  const h1 = (await tes.call('GET', `/v1/withdrawals/${w2.id}`)).body.tx_hash;
  await rpc('evm_mine'); // se mina el original…
  const fake = '0x' + 'ab'.repeat(32);
  await db.query('UPDATE withdrawals SET tx_hash = $2 WHERE id = $1', [w2.id, fake]); // …pero el registro apunta a otro intento
  check('acelerar con el nonce ya minado → 409 already_mined', (await tes.call('POST', `/v1/withdrawals/${w2.id}/bump`, {})).body.code, 'already_mined');
  await tick();
  d = (await tes.call('GET', `/v1/withdrawals/${w2.id}`)).body;
  check('confirma con el intento anterior y adopta su hash', `${d.status} ${d.tx_hash === h1}`, 'confirmed true');
  check('  …destino suma 0.15 ETH', await pub.getBalance({ address: DEST }), parseEther('0.15').toString());

  // ═════ 3. Bitácora y conciliación
  const { rows } = await db.query(`SELECT actor, status FROM audit_log WHERE action = 'POST /v1/withdrawals/:id/bump' AND target = $1`, [w1.id]);
  check('bitácora: aceleración manual por tesorero', rows.some((r) => r.actor === BOOT_EMAIL.toLowerCase() && r.status === 200), true);
  check('bitácora: intento del operador denegado', (await db.query(`SELECT 1 FROM audit_log WHERE action = 'POST /v1/withdrawals/:id/bump' AND status = 403`)).rowCount >= 1, true);
  const rec = (await tes.call('GET', '/v1/treasury/hot-wallet')).body.balances.find((b) => b.asset_id === ETH);
  check('conciliación ETH en cero tras reemplazos', rec.difference, '0');
} finally {
  await rpc('evm_setAutomine', [true]);
  await db.end();
}
console.log(`\n${ok} ok, ${fail} fallos`);
process.exit(fail ? 1 : 0);
