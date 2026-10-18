// E2E fase M1 — paso a mainnet con sandbox para clientes.
//  1. Reglas de arranque (se lanza el servidor con variables de production/sandbox y se verifica que se rechace o arranque).
//  2. production: modo de alta sin tesorero con 2FA, catálogo de activos main (decimales 6 vs 18, conversión exacta).
//  3. sandbox (servidor en BASE): transferencia interna valida activos (422), modo de un solo tesorero, mínimo de barrido.
// Uso: BASE KEY DATABASE_URL RPC_URL TOKEN FUNDER_PK PROD_DB TOTP_ENCRYPTION_KEY node test/m1.e2e.mjs
//   El servidor en BASE: ENVIRONMENT=sandbox, ORIGIN_RULE=off, SWEEP_ENABLED=true, WORKER_ENABLED=false, CONFIRMATIONS=1,
//   SWEEP_MIN_TUSD_M1=500000000 y base de datos NUEVA (cuenta tesoreros con 2FA desde cero).
//   PROD_DB: otra base vacía (se usa para el servidor de production que lanza esta prueba en el puerto 8087).
import { spawn } from 'node:child_process';
import pg from 'pg';
import { createPublicClient, createWalletClient, erc20Abi, http } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { hardhat } from 'viem/chains';
import { totp } from './lib/totp.mjs';
import { makeApprover } from './lib/approver.mjs';

const { BASE, KEY, DATABASE_URL, RPC_URL, TOKEN, FUNDER_PK, PROD_DB, TOTP_ENCRYPTION_KEY } = process.env;
const R = Math.random().toString(36).slice(2, 8);
const NET = `10.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`;
let ok = 0, fail = 0;
const check = (n, got, want) => { if (String(got) === String(want)) { ok++; console.log('✔', n); } else { fail++; console.log(`✘ ${n} — esperado ${want}, obtenido ${got}`); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ═════════════ 1. Reglas de arranque ═════════════
const PORT = 8087, PBASE = `http://127.0.0.1:${PORT}`;
// Frase mnemónica PÚBLICA de pruebas (Hardhat/Foundry): nunca tiene fondos reales
const TEST_MNEMONIC = 'test test test test test test test test test test test junk';
const prodEnv = (extra = {}) => ({
  PATH: process.env.PATH, HOME: process.env.HOME, NODE_EXTRA_CA_CERTS: process.env.NODE_EXTRA_CA_CERTS ?? '',
  DATABASE_URL: PROD_DB, PORT: String(PORT), HOST: '127.0.0.1', API_KEYS: KEY, ALCHEMY_API_KEY: 'llave-de-prueba-sin-red',
  ENVIRONMENT: 'production', ALCHEMY_NETWORK: 'eth-mainnet', NETWORKS: 'base-mainnet,arb-mainnet,bnb-mainnet',
  ORIGIN_RULE: 'enforce', TOTP_ENCRYPTION_KEY, COOKIE_SECURE: 'false', WORKER_ENABLED: 'false', RATE_LIMIT_PER_MIN: '100000',
  SIGNER_PRIVATE_KEY: generatePrivateKey(), HD_MNEMONIC: TEST_MNEMONIC, ...extra,
});
const clean = (e) => Object.fromEntries(Object.entries(e).filter(([, v]) => v !== undefined));
/** Lanza el servidor; termina cuando sale (rechazo) o cuando escucha (arranque). */
function boot(env, ms = 60_000) {
  return new Promise((resolve) => {
    const p = spawn('node', ['dist/server.js'], { env: clean(env), stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    const done = (r) => { clearTimeout(t); resolve({ ...r, out, proc: p }); };
    const t = setTimeout(() => done({ code: 'timeout' }), ms);
    const onData = (d) => { out += d; if (out.includes('Server listening')) done({ code: 'listening' }); };
    p.stdout.on('data', onData); p.stderr.on('data', onData);
    p.on('exit', (code) => done({ code }));
  });
}
const stop = (b) => new Promise((r) => { if (b.proc.exitCode !== null) return r(); b.proc.on('exit', r); b.proc.kill('SIGTERM'); });

let b = await boot({ ...prodEnv(), ENVIRONMENT: 'sandbox', ALCHEMY_NETWORK: 'eth-sepolia', NETWORKS: 'eth-mainnet', HD_MNEMONIC: undefined });
check('sandbox con una red main → arranque rechazado', `${b.code} ${b.out.includes('no se mezclan')}`, '1 true');
b = await boot(prodEnv({ NETWORKS: 'base-mainnet,base-sepolia' }));
check('production con una red de prueba → arranque rechazado', `${b.code} ${b.out.includes('no se mezclan')}`, '1 true');
b = await boot(prodEnv({ NETWORKS: 'opt-mainnet' }));
check('production con una red desconocida → rechazado', `${b.code} ${b.out.includes('Red desconocida')}`, '1 true');
b = await boot(prodEnv({ ORIGIN_RULE: 'off' }));
check('production sin ORIGIN_RULE=enforce → rechazado', `${b.code} ${b.out.includes('ORIGIN_RULE=enforce es obligatorio')}`, '1 true');
b = await boot(prodEnv({ HD_MNEMONIC: undefined }));
check('production sin semilla HD propia → rechazado', `${b.code} ${b.out.includes('semilla de direcciones de depósito')}`, '1 true');
b = await boot(prodEnv({ SWEEP_MIN_USDT_MAINNET: '50.5' }));
check('SWEEP_MIN con decimales → rechazado (unidades base enteras)', `${b.code} ${b.out.includes('SWEEP_MIN_USDT_MAINNET')}`, '1 true');
b = await boot(prodEnv());
check('production sin ningún tesorero con 2FA ni alta inicial → rechazado', `${b.code} ${b.out.includes('sin tesorero activo con 2FA')}`, '1 true');

// ═════════════ 2. production: modo de alta, catálogo y decimales ═════════════
const pdb = new pg.Pool({ connectionString: PROD_DB });
const TES = `tes-m1-${R}@ejemplo.mx`, TES_PW = 'clave-tesorero-m1-123';
b = await boot(prodEnv({ CONSOLE_BOOTSTRAP_EMAIL: TES, CONSOLE_BOOTSTRAP_PASSWORD: TES_PW }));
check('production con alta inicial → arranca en modo de alta', `${b.code} ${b.out.includes('MODO DE ALTA')}`, 'listening true');
const papi = async (method, path, body) => {
  const r = await fetch(PBASE + path, { method, headers: { 'x-api-key': KEY, 'content-type': 'application/json', 'idempotency-key': `m1-${path}-${Math.random()}` }, body: body && JSON.stringify(body) });
  return { status: r.status, body: await r.json().catch(() => null) };
};
let meta = await (await fetch(PBASE + '/v1/meta')).json();
check('/v1/meta público: production y modo de alta', `${meta.environment} ${meta.setup_required}`, 'production true');
const blocked = await papi('GET', '/v1/assets');
check('en modo de alta /v1 responde 503 setup_required', `${blocked.status} ${blocked.body?.code}`, '503 setup_required');
check('  …también el portal', (await fetch(PBASE + '/v1/portal/me')).status, 503);

// Catálogo main (alta idempotente al arrancar) y activos de prueba inactivos
const { rows: cat } = await pdb.query(`SELECT id, network, decimals, contract_address, active FROM assets ORDER BY id`);
const A = Object.fromEntries(cat.map((r) => [r.id, r]));
check('14 activos main dados de alta', cat.filter((r) => r.active && ['eth-mainnet', 'base-mainnet', 'arb-mainnet', 'bnb-mainnet'].includes(r.network)).length, 14);
check('activos de prueba inactivos en production', cat.filter((r) => r.active && /sepolia|amoy|testnet/.test(r.network)).length, 0);
check('USDT en Ethereum: 6 decimales, contrato de Tether', `${A['USDT-MAINNET'].decimals} ${A['USDT-MAINNET'].contract_address}`, '6 0xdac17f958d2ee523a2206206994597c13d831ec7');
check('USDT en Arbitrum (USDT0): 6 decimales', A['USDT-ARB'].decimals, 6);
check('USDT y USDC en BNB: 18 decimales', `${A['USDT-BSC'].decimals} ${A['USDC-BSC'].decimals}`, '18 18');
check('EURe en Base: 18 decimales, contrato de Monerium', `${A['EURE-BASE'].decimals} ${A['EURE-BASE'].contract_address}`, '18 0xbf6e2966a9c3d99c9e4d069e04f7bdb9c8aa762c');

// El tesorero activa su 2FA desde la consola → el servicio sale del modo de alta
let cookie = null;
const ccall = async (method, path, body) => {
  const r = await fetch(PBASE + path, { method, headers: { 'x-forwarded-for': `${NET}.9`, 'content-type': 'application/json', ...(cookie ? { cookie } : {}), ...(method !== 'GET' ? { 'x-856-console': '1' } : {}) }, body: body && JSON.stringify(body) });
  const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
  return { status: r.status, body: await r.json().catch(() => null) };
};
check('login del tesorero en modo de alta', (await ccall('POST', '/v1/auth/login', { email: TES, password: TES_PW })).status, 200);
const st = (await ccall('POST', '/v1/auth/totp/setup', {})).body;
const otp = totp(st.secret);
check('  …activa su 2FA', (await ccall('POST', '/v1/auth/totp/enable', { code: await otp.next() })).status, 200);
await sleep(5_500);
meta = await (await fetch(PBASE + '/v1/meta')).json();
check('con un tesorero con 2FA sale del modo de alta', meta.setup_required, false);
const assets = await papi('GET', '/v1/assets');
check('  …/v1 vuelve a operar y no lista activos de prueba', `${assets.status} ${assets.body.assets.some((a) => a.id === 'ETH-SEPOLIA')} ${assets.body.assets.some((a) => a.id === 'USDT-BSC')}`, '200 false true');
const sum = await ccall('GET', '/v1/summary');
check('tablero: production y un solo tesorero', `${sum.body?.environment} ${sum.body?.treasurers?.single}`, 'production true');

// Conversión exacta 6 vs 18 decimales (sin flotantes): 1.5 USDT en Ethereum y en BNB
const human = (s, d) => { const [i, f = ''] = s.split('.'); return (BigInt(i) * 10n ** BigInt(d) + BigInt(f.padEnd(d, '0') || '0')).toString(); };
const amt6 = human('1.5', A['USDT-MAINNET'].decimals), amt18 = human('1.5', A['USDT-BSC'].decimals);
check('1.5 USDT → 1500000 (6) y 1500000000000000000 (18)', `${amt6} ${amt18}`, '1500000 1500000000000000000');
const big = (10n ** 24n + 7n).toString(); // 1,000,000.000000000000000007 USDT-BSC: no cabe en un double
const e18 = await papi('POST', '/v1/entries', { kind: 'adjustment', description: 'prueba de precisión', postings: [
  { account: 'system:USDT-BSC:custody', direction: 'debit', amount: big }, { account: 'system:USDT-BSC:equity', direction: 'credit', amount: big }] });
check('asiento en USDT-BSC de 10^24+7 unidades base', e18.status, 201);
check('  …saldo exacto (sin redondeo)', (await papi('GET', '/v1/accounts/system:USDT-BSC:custody')).body.balance, big);
await stop(b);

// Un activo ya existente con otro contrato o decimales detiene el arranque
await pdb.query(`UPDATE assets SET decimals = 6 WHERE id = 'USDT-BSC'`);
b = await boot(prodEnv());
check('activo main con decimales distintos al catálogo → arranque rechazado', `${b.code} ${b.out.includes('datos distintos al catálogo')}`, '1 true');
await pdb.query(`UPDATE assets SET decimals = 18 WHERE id = 'USDT-BSC'`);
b = await boot(prodEnv());
check('  …corregido, arranca (ya con tesorero con 2FA, sin modo de alta)', `${b.code} ${b.out.includes('MODO DE ALTA')}`, 'listening false');
await stop(b);
await pdb.end();

// ═════════════ 3. sandbox: reglas en operación ═════════════
const db = new pg.Pool({ connectionString: DATABASE_URL });
const api = async (method, path, body, idem) => {
  const r = await fetch(BASE + path, { method, headers: { 'x-api-key': KEY, 'content-type': 'application/json', ...(idem ? { 'idempotency-key': `${idem}-${R}` } : {}) }, body: body && JSON.stringify(body) });
  return { status: r.status, body: await r.json().catch(() => null) };
};
meta = await (await fetch(BASE + '/v1/meta')).json();
check('sandbox: /v1/meta environment', `${meta.environment} ${meta.setup_required}`, 'sandbox false');
const ETH = 'ETH-SEPOLIA';
const E = (n) => (BigInt(Math.round(n * 1e6)) * 10n ** 12n).toString();

// 3a. Transferencia interna valida activos habilitados (422)
const cA = (await api('POST', '/v1/clients', { name: `M1 Alfa ${R}`, assets: [ETH] }, 'ca')).body;
const cB = (await api('POST', '/v1/clients', { name: `M1 Beta ${R}`, assets: [ETH] }, 'cb')).body;
await api('POST', '/v1/entries', { kind: 'deposit', postings: [
  { account: `client:${cA.id}:${ETH}:available`, direction: 'credit', amount: E(1) }, { account: `system:${ETH}:custody`, direction: 'debit', amount: E(1) }] }, 'fa');
const accB = `client:${cB.id}:${ETH}:available`;
await api('PUT', `/v1/clients/${cB.id}/assets/${ETH}`, { status: 'disabled' });
const xfer = (n, from, to) => api('POST', '/v1/internal-transfers', { from, to, amount: E(0.1) }, `x${n}`);
const accA = `client:${cA.id}:${ETH}:available`;
let t = await xfer(1, accA, accB);
check('transferencia interna a un cliente sin el activo → 422 asset_not_enabled', `${t.status} ${t.body?.code}`, '422 asset_not_enabled');
await api('PUT', `/v1/clients/${cB.id}/assets/${ETH}`, { status: 'exit_only' });
t = await xfer(2, accA, accB);
check('  …destino en «solo salida» → 422', `${t.status} ${t.body?.code}`, '422 asset_not_enabled');
await api('PUT', `/v1/clients/${cB.id}/assets/${ETH}`, { status: 'enabled' });
check('  …destino habilitado → 201', (await xfer(3, accA, accB)).status, 201);
await api('PUT', `/v1/clients/${cA.id}/assets/${ETH}`, { status: 'exit_only' });
check('  …origen en «solo salida» sí envía → 201', (await xfer(4, accA, accB)).status, 201);
check('  …saldo de B exacto', (await api('GET', `/v1/accounts/${accB}`)).body.balance, E(0.2));
await api('PUT', `/v1/clients/${cA.id}/assets/${ETH}`, { status: 'enabled' });

// 3b. Modo de un solo tesorero (base nueva: ningún tesorero con 2FA al empezar)
const T1 = await makeApprover({ BASE, ip: `${NET}.20`, tag: `m1t1-${R}` });
const sumOf = async (T) => (await T.call('GET', '/v1/summary')).body;
check('un tesorero con 2FA → «un solo tesorero» en el tablero', (await sumOf(T1)).treasurers?.single, true);
await api('PATCH', `/v1/clients/${cA.id}`, { status: 'active' });
const PW = 'clave-portal-m1-123';
function session(ip) {
  let ck = null;
  const call = async (method, path, body) => {
    const r = await fetch(BASE + '/v1/portal' + path, { method, headers: { 'x-forwarded-for': ip, ...(body ? { 'content-type': 'application/json' } : {}), ...(ck ? { cookie: ck } : {}), ...(method !== 'GET' ? { 'x-856-portal': '1' } : {}) }, body: body && JSON.stringify(body) });
    const sc = r.headers.get('set-cookie'); if (sc) ck = sc.split(';')[0];
    return { status: r.status, body: await r.json().catch(() => null) };
  };
  return { call };
}
async function enroll(n, role, inviter) {
  const email = `m1-${role}-${n}-${R}@ejemplo.mx`;
  const inv = inviter ? (await inviter.s.call('POST', '/users/invites', { email, role })).body : (await api('POST', `/v1/clients/${cA.id}/portal-invite`, { email })).body;
  const s = session(`${NET}.${n}`);
  await s.call('POST', '/invites/accept', { token: inv.link.split('#')[1], name: `Usuario ${n}`, password: PW });
  await s.call('POST', '/auth/login', { email, password: PW });
  const o = (await s.call('POST', '/auth/totp/setup', {})).body; const code = totp(o.secret);
  await s.call('POST', '/auth/totp/enable', { code: await code.next() });
  return { s, otp: code };
}
const adm = await enroll(2, 'admin');
const apr = await enroll(3, 'approver', adm);
const DEST = '0x' + 'ab'.repeat(20);
const wl = (await adm.s.call('POST', '/whitelist', { address: DEST })).body;
await apr.s.call('POST', `/whitelist/${wl.id}/approve`, { code: await apr.otp.next() });
await db.query(`UPDATE wallets SET active_from = now() - interval '1 minute' WHERE id = $1`, [wl.id]);
const exit = async (amt) => {
  const sim = (await adm.s.call('POST', '/exits/simulate', { asset_id: ETH, whitelist_id: wl.id, amount: amt })).body;
  return (await adm.s.call('POST', '/exits', { simulation_id: sim.id })).body;
};
const x1 = await exit(E(0.06));
check('salida de cliente requiere una autorización individual', x1.authorizations?.required, 1);
const a1 = await T1.approveWithdrawal(x1.id);
check('tesorero autoriza con 2FA → aprobada', `${a1.status} ${a1.body.approval_status}`, '200 approved');
const x2 = await exit(E(0.07));
const b1 = await T1.approveWithdrawal(x2.id);
check('un solo tesorero basta, sin importar el monto', `${b1.status} ${b1.body.approval_status}`, '200 approved');
check('no se admite otra aprobación → 409', (await T1.approveWithdrawal(x2.id)).status, 409);

// 3c. Mínimo de barrido por activo (SWEEP_MIN_TUSD_M1=500 TUSD en el servidor)
const pub = createPublicClient({ chain: hardhat, transport: http(RPC_URL) });
const funder = createWalletClient({ account: privateKeyToAccount(FUNDER_PK), chain: hardhat, transport: http(RPC_URL) });
const U = (n) => BigInt(n) * 10n ** 6n;
const ra = await api('POST', '/v1/assets', { id: 'TUSD-M1', symbol: 'TUSD', chain: 'ethereum', network: 'eth-sepolia', kind: 'erc20', contract_address: TOKEN, decimals: 6 });
check('activo de prueba TUSD-M1', [201, 409].includes(ra.status), true);
const cS = (await api('POST', '/v1/clients', { name: `M1 Barrido ${R}`, assets: ['TUSD-M1'] }, 'cs')).body;
const dep = (await api('POST', `/v1/clients/${cS.id}/deposit-address`, {})).body;
const send = async (n) => {
  const h = await funder.writeContract({ address: TOKEN, abi: erc20Abi, functionName: 'transfer', args: [dep.address, U(n)] });
  await pub.waitForTransactionReceipt({ hash: h });
  await api('POST', '/v1/deposits/report', { tx_hash: h });
  for (let i = 0; i < 3; i++) await pub.request({ method: 'evm_mine', params: [] });
  await api('POST', '/v1/worker/tick'); await api('POST', '/v1/worker/tick');
};
const sweeps = async () => (await db.query(`SELECT count(*)::int AS n FROM sweeps s JOIN wallets w ON w.id = s.wallet_id WHERE w.address = $1`, [dep.address.toLowerCase()])).rows[0].n;
await send(100);
check('depósito de 100 bajo el mínimo: se acredita al cliente', (await api('GET', `/v1/accounts/client:${cS.id}:TUSD-M1:available`)).body.balance, U(100).toString());
check('  …pero no se barre (bajo SWEEP_MIN)', await sweeps(), 0);
await send(450);
check('al superar el mínimo (550 ≥ 500) sí se barre', (await sweeps()) > 0, true);

await db.end();
console.log(`${ok} ok, ${fail} fallos`);
process.exit(fail ? 1 : 0);
