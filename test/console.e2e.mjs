// E2E fase 1 de la consola: login de operadores, roles, CSRF, bitácora, /v1/summary, /v1/clients, /v1/entries y estáticos.
// Uso: BASE KEY RPC_URL FUNDER_PK DATABASE_URL node test/console.e2e.mjs
//  - El API debe correr con COOKIE_SECURE=false y CONSOLE_BOOTSTRAP_EMAIL/PASSWORD (variables BOOT_EMAIL/BOOT_PASS aquí).
import { execFileSync } from 'node:child_process';
import pg from 'pg';
import { createWalletClient, http, parseEther } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { hardhat } from 'viem/chains';

const { BASE, KEY, RPC_URL, FUNDER_PK, DATABASE_URL, BOOT_EMAIL, BOOT_PASS } = process.env;
const db = new pg.Client({ connectionString: DATABASE_URL });
await db.connect();
const R = Math.random().toString(36).slice(2, 8);
const NET = `10.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`; // IPs simuladas propias de esta corrida
let ok = 0, fail = 0;
const check = (n, got, want) => { if (String(got) === String(want)) { ok++; console.log('✔', n); } else { fail++; console.log(`✘ ${n} — esperado ${want}, obtenido ${got}`); } };

// Cliente HTTP con "navegador" simulado: guarda la cookie, IP propia (X-Forwarded-For) para no compartir límite de login
function browser(ip) {
  let cookie = null;
  const call = async (method, path, body, extra = {}) => {
    const r = await fetch(BASE + path, {
      method, redirect: 'manual',
      headers: { 'x-forwarded-for': ip, ...(body ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}), ...extra },
      body: body && JSON.stringify(body),
    });
    const sc = r.headers.get('set-cookie');
    if (sc) cookie = sc.split(';')[0].endsWith('=') ? null : sc.split(';')[0];
    const ct = r.headers.get('content-type') ?? '';
    return { status: r.status, headers: r.headers, setCookie: sc, body: ct.includes('json') ? await r.json() : await r.text() };
  };
  return { call, get cookie() { return cookie; }, set cookie(v) { cookie = v; },
    login: (email, password) => call('POST', '/v1/auth/login', { email, password }),
    post: (path, body, idem) => call('POST', path, body, { 'x-856-console': '1', ...(idem ? { 'idempotency-key': `${idem}-${R}` } : {}) }) };
}
const key = async (method, path, body, idem) => {
  const r = await fetch(BASE + path, { method, headers: { 'x-api-key': KEY, 'content-type': 'application/json', ...(idem ? { 'idempotency-key': `${idem}-${R}` } : {}) }, body: body && JSON.stringify(body) });
  return { status: r.status, body: await r.json() };
};
const createOperator = (email, role, password) => execFileSync('node', ['dist/scripts/create-operator.js', email, role, `Prueba ${role}`], { input: password + '\n', env: process.env }).toString();

// ── 1. Acceso sin sesión
const anon = browser(`${NET}.1`);
check('summary sin sesión → 401', (await anon.call('GET', '/v1/summary')).status, 401);
check('login con contraseña errónea → 401', (await anon.login(BOOT_EMAIL, 'no-es-la-clave')).status, 401);

// ── 2. Login del tesorero inicial
const tes = browser(`${NET}.2`);
const lg = await tes.login(BOOT_EMAIL, BOOT_PASS);
check('login tesorero → 200', lg.status, 200);
check('rol tesorero', lg.body.operator?.role, 'tesorero');
check('cookie HttpOnly', /HttpOnly/i.test(lg.setCookie), true);
check('cookie SameSite=Strict', /SameSite=Strict/i.test(lg.setCookie), true);
check('respuesta de login sin token ni hash', JSON.stringify(lg.body).includes('password') || JSON.stringify(lg.body).includes(tes.cookie.split('=')[1]), false);
check('/auth/me', (await tes.call('GET', '/v1/auth/me')).body.operator?.email, BOOT_EMAIL);
const { rows: [sess] } = await db.query(`SELECT token_hash FROM operator_sessions ORDER BY created_at DESC LIMIT 1`);
check('BD guarda hash del token, no el token', sess.token_hash !== tes.cookie.split('=')[1] && sess.token_hash.length === 64, true);

// ── 3. Coexistencia con x-api-key
check('x-api-key sigue funcionando', (await key('GET', '/v1/summary')).status, 200);
check('x-api-key inválida con cookie válida → 401', (await tes.call('GET', '/v1/summary', null, { 'x-api-key': 'mala' })).status, 401);
check('/auth/me con api key → 403', (await key('GET', '/v1/auth/me')).status, 403);

// ── 4. CSRF
check('POST sin header de consola → 403', (await tes.call('POST', '/v1/clients', { name: 'X' }, { 'idempotency-key': `csrf-${R}` })).status, 403);

// ── 5. Tablero: conciliación y gas
const funder = createWalletClient({ account: privateKeyToAccount(FUNDER_PK), chain: hardhat, transport: http(RPC_URL) });
let s = (await tes.call('GET', '/v1/summary')).body;
check('summary health ok', s.health.status, 'ok');
check('summary trae activos con decimales', s.assets.find((a) => a.id === 'ETH-SEPOLIA')?.decimals, 18);
const HOT = s.reconciliation.address;
await funder.sendTransaction({ to: HOT, value: parseEther('0.02') });
await new Promise((r) => setTimeout(r, 10_500)); // caché de conciliación (10 s)
s = (await tes.call('GET', '/v1/summary')).body;
let eth = s.reconciliation.balances.find((b) => b.asset_id === 'ETH-SEPOLIA');
check('diferencia ≠ 0 tras fondear sin asiento', BigInt(eth.difference) > 0n, true);
check('gas.low coherente con saldo y umbral', s.gas.low, BigInt(s.gas.balance_wei) < BigInt(s.gas.threshold_wei));
const gap = eth.difference;
check('asiento de ajuste de gas (tesorero)', (await tes.post('/v1/entries', { kind: 'adjustment', description: 'Fondeo gas e2e', postings: [
  { account: 'system:ETH-SEPOLIA:custody', direction: 'debit', amount: gap },
  { account: 'system:ETH-SEPOLIA:equity', direction: 'credit', amount: gap }] }, 'gas')).status, 201);
await funder.sendTransaction({ to: HOT, value: parseEther('0.1') });
await new Promise((r) => setTimeout(r, 10_500));
s = (await tes.call('GET', '/v1/summary')).body;
eth = s.reconciliation.balances.find((b) => b.asset_id === 'ETH-SEPOLIA');
check('diferencia = 0.1 ETH (solo el segundo fondeo sin asiento)', eth.difference, parseEther('0.1').toString());
check('gas ya no es bajo', s.gas.low, false);

// ── 6. Roles
createOperator(`lectura-${R}@ejemplo.mx`, 'lectura', 'clave-lectura-123');
createOperator(`operador-${R}@ejemplo.mx`, 'operador', 'clave-operador-123');
const lec = browser(`${NET}.3`); await lec.login(`lectura-${R}@ejemplo.mx`, 'clave-lectura-123');
const opr = browser(`${NET}.4`); await opr.login(`operador-${R}@ejemplo.mx`, 'clave-operador-123');
check('lectura puede leer summary', (await lec.call('GET', '/v1/summary')).status, 200);
check('lectura no puede crear cliente → 403', (await lec.post('/v1/clients', { name: 'No' }, 'lec')).status, 403);
const cOp = await opr.post('/v1/clients', { name: `Fondo Op ${R}`, assets: ['ETH-SEPOLIA'] }, 'opc');
check('operador crea cliente → 201', cOp.status, 201);
check('idempotencia por operador (repetición)', (await opr.post('/v1/clients', { name: `Fondo Op ${R}`, assets: ['ETH-SEPOLIA'] }, 'opc')).headers.get('idempotent-replayed'), 'true');
check('operador no puede retirar → 403', (await opr.post('/v1/withdrawals', { client_id: cOp.body.id, asset_id: 'ETH-SEPOLIA', to_address: HOT, amount: '1' }, 'opw')).status, 403);
check('operador no puede ajustar libro → 403', (await opr.post('/v1/entries', { kind: 'adjustment', postings: [] }, 'ope')).status, 403);
check('contraseña corta rechazada por el script', (() => { try { createOperator(`x-${R}@ejemplo.mx`, 'lectura', 'corta'); return 'creado'; } catch { return 'rechazada'; } })(), 'rechazada');

// ── 7. Retiro en vuelo visible en el tablero
const cl = (await key('POST', '/v1/clients', { name: `Cliente Retiro ${R}`, assets: ['ETH-SEPOLIA'] }, 'clw')).body;
const ACC = `client:${cl.id}:ETH-SEPOLIA:available`;
await key('POST', '/v1/entries', { kind: 'deposit', postings: [
  { account: 'system:ETH-SEPOLIA:custody', direction: 'debit', amount: '5000000000000000' },
  { account: ACC, direction: 'credit', amount: '5000000000000000' }] }, 'dep');
const DEST = privateKeyToAccount(generatePrivateKey()).address; // única por corrida (lista blanca es única por red)
await key('POST', '/v1/wallets', { client_id: cl.id, chain: 'ethereum', network: 'eth-sepolia', address: DEST, purpose: 'withdrawal_whitelist' });
const wd = await tes.post('/v1/withdrawals', { client_id: cl.id, asset_id: 'ETH-SEPOLIA', to_address: DEST, amount: '1000000000000000' }, 'wd');
check('tesorero solicita retiro → 202', wd.status, 202);
s = (await lec.call('GET', '/v1/summary')).body;
const item = s.withdrawals_in_flight.items.find((w) => w.id === wd.body.id);
check('retiro en vuelo en el tablero', item?.status, 'reserved');
check('retiro trae nombre de cliente', item?.client_name, `Cliente Retiro ${R}`);
check('conteo por estado reserved ≥ 1', s.withdrawals_in_flight.by_status.reserved >= 1, true);

// ── 8. Bitácora
const { rows: aud } = await db.query(`SELECT actor, action, status FROM audit_log ORDER BY id`);
check('bitácora: login_failed', aud.some((a) => a.action === 'login_failed'), true);
check('bitácora: login', aud.some((a) => a.action === 'login' && a.actor === BOOT_EMAIL), true);
check('bitácora: retiro del tesorero', aud.some((a) => a.action === 'POST /v1/withdrawals' && a.status === 202), true);
check('bitácora: intento denegado de lectura', aud.some((a) => a.action === 'POST /v1/clients' && a.status === 403 && a.actor.startsWith('lectura')), true);
check('bitácora inmutable', await db.query('UPDATE audit_log SET actor = $1', ['x']).then(() => 'editable', () => 'inmutable'), 'inmutable');

// ── 9. /v1/clients paginado
for (let i = 0; i < 5; i++) await key('POST', '/v1/clients', { name: `Pag ${R} ${i}`, kind: 'fund' }, `pag${i}`);
const seen = new Set(); let cursor = null; let pages = 0;
do {
  const r = (await lec.call('GET', `/v1/clients?limit=2&q=Pag%20${R}${cursor ? `&cursor=${cursor}` : ''}`)).body;
  r.clients.forEach((c) => seen.add(c.id)); cursor = r.next_cursor; pages++;
} while (cursor && pages < 10);
check('clientes: 5 únicos en 3 páginas', `${seen.size}/${pages}`, '5/3');
check('clientes: filtro status', (await lec.call('GET', '/v1/clients?status=closed')).body.clients.length, 0);
check('clientes: cursor inválido → 400', (await lec.call('GET', '/v1/clients?cursor=basura')).status, 400);
check('clientes: accounts_count', (await lec.call('GET', `/v1/clients?q=${cl.id}`)).body.clients[0]?.accounts_count, 1);

// ── 10. /v1/entries con filtros
const byClient = (await lec.call('GET', `/v1/entries?client_id=${cl.id}`)).body.entries;
check('asientos por cliente (depósito + reserva)', byClient.length, 2);
check('asientos traen partidas con monto string', typeof byClient[0].postings[0].amount, 'string');
check('asientos por cuenta (code)', (await lec.call('GET', `/v1/entries?account=${encodeURIComponent(ACC)}&kind=deposit`)).body.entries.length, 1);
check('asientos sin partidas', 'postings' in (await lec.call('GET', '/v1/entries?limit=1&postings=false')).body.entries[0], false);
const e1 = (await lec.call('GET', '/v1/entries?limit=1')).body;
const e2 = (await lec.call('GET', `/v1/entries?limit=1&cursor=${e1.next_cursor}`)).body;
check('asientos: páginas distintas', e1.entries[0].id !== e2.entries[0].id, true);
check('asientos: fecha inválida → 400', (await lec.call('GET', '/v1/entries?from=ayer')).status, 400);

// ── 11. Bloqueo por intentos y límite de login
const lock = browser(`${NET}.5`);
for (let i = 0; i < 5; i++) await lock.login(`operador-${R}@ejemplo.mx`, 'mala-clave-xx');
check('cuenta bloqueada tras 5 fallos (aun con clave correcta)', (await lock.login(`operador-${R}@ejemplo.mx`, 'clave-operador-123')).status, 401);
check('sesión previa del operador sigue viva', (await opr.call('GET', '/v1/auth/me')).status, 200);
const flood = browser(`${NET}.6`); let last;
for (let i = 0; i < 11; i++) last = await flood.login('nadie@ejemplo.mx', 'x');
check('límite de login por IP → 429', last.status, 429);

// ── 12. Logout y revocación
const stolen = tes.cookie;
check('logout → 200', (await tes.post('/v1/auth/logout', {})).status, 200);
check('me tras logout → 401', (await tes.call('GET', '/v1/auth/me')).status, 401);
tes.cookie = stolen;
check('cookie copiada antes del logout ya no sirve', (await tes.call('GET', '/v1/summary')).status, 401);

// ── 13. Consola estática
const idx = await anon.call('GET', '/console/');
check('/console/ sirve index.html', idx.status === 200 && String(idx.body).includes('<div id="root">'), true);
check('/console/login (ruta SPA) sirve index.html', String((await anon.call('GET', '/console/login')).body).includes('<div id="root">'), true);
check('/console redirige a /console/', (await anon.call('GET', '/console')).status, 302);
const js = String(idx.body).match(/\/console\/assets\/[^"]+\.js/)?.[0];
const jsr = await anon.call('GET', js);
check('assets con caché inmutable', jsr.headers.get('cache-control')?.includes('immutable'), true);
check('bundle sin API key', String(jsr.body).includes(KEY), false);
check('CSP presente', !!idx.headers.get('content-security-policy'), true);

await db.end();
console.log(`\n${ok} ok, ${fail} fallos`);
process.exit(fail ? 1 : 0);
