// E2E fase 2 de la consola: ciclo de vida del cliente, bloqueo de saldo por estado, lista blanca y cuentas.
// Uso: BASE KEY DATABASE_URL BOOT_EMAIL BOOT_PASS node test/console-fase2.e2e.mjs  (API con COOKIE_SECURE=false)
import { execFileSync } from 'node:child_process';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';

const { BASE, KEY, BOOT_EMAIL, BOOT_PASS } = process.env;
const R = Math.random().toString(36).slice(2, 8);
const NET = `10.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`;
let ok = 0, fail = 0;
const check = (n, got, want) => { if (String(got) === String(want)) { ok++; console.log('✔', n); } else { fail++; console.log(`✘ ${n} — esperado ${want}, obtenido ${got}`); } };

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
const createOperator = (email, role, pw) => execFileSync('node', ['dist/scripts/create-operator.js', email, role], { input: pw + '\n', env: process.env, stdio: ['pipe', 'pipe', 'ignore'] });
const addr = () => privateKeyToAccount(generatePrivateKey()).address;

const tes = browser(`${NET}.1`); check('login tesorero', (await tes.login(BOOT_EMAIL, BOOT_PASS)).status, 200);
createOperator(`op2-${R}@ejemplo.mx`, 'operador', 'clave-operador-123');
createOperator(`lec2-${R}@ejemplo.mx`, 'lectura', 'clave-lectura-123');
const opr = browser(`${NET}.2`); await opr.login(`op2-${R}@ejemplo.mx`, 'clave-operador-123');
const lec = browser(`${NET}.3`); await lec.login(`lec2-${R}@ejemplo.mx`, 'clave-lectura-123');

// ── Alta y edición
const A = (await opr.call('POST', '/v1/clients', { name: `Cliente A ${R}`, kind: 'fund', assets: ['ETH-SEPOLIA'] }, { 'idempotency-key': `a-${R}` })).body;
const B = (await key('POST', '/v1/clients', { name: `Cliente B ${R}`, assets: ['ETH-SEPOLIA'] }, 'b')).body;
let d = (await lec.call('GET', `/v1/clients/${A.id}`)).body;
check('detalle trae transiciones permitidas', d.allowed_transitions.join(','), 'active,closed');
check('lectura no edita → 403', (await lec.call('PATCH', `/v1/clients/${A.id}`, { name: 'X' })).status, 403);
check('operador edita nombre e id externo', (await opr.call('PATCH', `/v1/clients/${A.id}`, { name: `Cliente A2 ${R}`, external_id: `ERP-${R}` })).body.external_id, `ERP-${R}`);
check('quitar id externo (null)', (await opr.call('PATCH', `/v1/clients/${A.id}`, { external_id: null })).body.external_id, 'null');
check('PATCH vacío → 400', (await opr.call('PATCH', `/v1/clients/${A.id}`, {})).status, 400);

// ── Transiciones
check('activar (KYB) → active', (await opr.call('PATCH', `/v1/clients/${A.id}`, { status: 'active' })).body.status, 'active');
check('active → pending_kyb no permitido → 409', (await opr.call('PATCH', `/v1/clients/${A.id}`, { status: 'pending_kyb' })).status, 409);
check('suspender sin motivo → 400', (await opr.call('PATCH', `/v1/clients/${A.id}`, { status: 'suspended' })).status, 400);

// Fondear A para probar bloqueo
const ACC_A = `client:${A.id}:ETH-SEPOLIA:available`, ACC_B = `client:${B.id}:ETH-SEPOLIA:available`;
await key('POST', '/v1/entries', { kind: 'deposit', postings: [{ account: 'system:ETH-SEPOLIA:custody', direction: 'debit', amount: '3000' }, { account: ACC_A, direction: 'credit', amount: '3000' }] }, 'fa');
const W = addr();
check('lista blanca: operador no puede agregar → 403', (await opr.call('POST', '/v1/wallets', { client_id: A.id, chain: 'ethereum', network: 'eth-sepolia', address: W, purpose: 'withdrawal_whitelist' })).status, 403);
check('lista blanca: dirección inválida → 400', (await tes.call('POST', '/v1/wallets', { client_id: A.id, chain: 'ethereum', network: 'eth-sepolia', address: '0x123', purpose: 'withdrawal_whitelist' })).status, 400);
const wl = await tes.call('POST', '/v1/wallets', { client_id: A.id, chain: 'ethereum', network: 'eth-sepolia', address: W, purpose: 'withdrawal_whitelist', label: 'Tesorería' });
check('lista blanca: tesorero agrega → 201', wl.status, 201);

const sus = await opr.call('PATCH', `/v1/clients/${A.id}`, { status: 'suspended', reason: 'Revisión de cumplimiento' });
check('suspender con motivo', sus.body.status, 'suspended');
check('motivo guardado', sus.body.status_reason, 'Revisión de cumplimiento');
check('fecha de cambio guardada', !!sus.body.status_changed_at, true);
const t1 = await key('POST', '/v1/internal-transfers', { from: ACC_A, to: ACC_B, amount: '100' }, 't1');
check('suspendido no transfiere → 422', t1.status, 422);
check('mensaje de bloqueo', /no puede disponer/.test(t1.body.error), true);
check('suspendido no retira → 422', (await key('POST', '/v1/withdrawals', { client_id: A.id, asset_id: 'ETH-SEPOLIA', to_address: W, amount: '100' }, 'w1')).status, 422);
check('B sin saldo no transfiere → 422', (await key('POST', '/v1/internal-transfers', { from: ACC_B, to: ACC_A, amount: '1' }, 't2')).status, 422);
await key('POST', '/v1/entries', { kind: 'deposit', postings: [{ account: 'system:ETH-SEPOLIA:custody', direction: 'debit', amount: '50' }, { account: ACC_B, direction: 'credit', amount: '50' }] }, 'fb');
check('suspendido recibe transferencia', (await key('POST', '/v1/internal-transfers', { from: ACC_B, to: ACC_A, amount: '50' }, 't3')).status, 201);
check('saldo de A intacto + 50', (await key('GET', `/v1/accounts/${ACC_A}`)).body.balance, '3050');

// ── Reactivar y cerrar
check('reactivar', (await opr.call('PATCH', `/v1/clients/${A.id}`, { status: 'active' })).body.status, 'active');
check('reactivado transfiere', (await key('POST', '/v1/internal-transfers', { from: ACC_A, to: ACC_B, amount: '3050' }, 't4')).status, 201);
check('operador no puede cerrar → 403', (await opr.call('PATCH', `/v1/clients/${A.id}`, { status: 'closed', reason: 'Fin de relación' })).status, 403);
const cB = await tes.call('PATCH', `/v1/clients/${B.id}`, { status: 'closed', reason: 'Fin de relación' });
check('cerrar con saldo → 409', cB.status, 409);
check('mensaje indica saldos', /balances/.test(cB.body.error), true);
check('cerrar A (saldo 0) → closed', (await tes.call('PATCH', `/v1/clients/${A.id}`, { status: 'closed', reason: 'Fin de relación' })).body.status, 'closed');
check('cerrado no admite cambios → 409', (await tes.call('PATCH', `/v1/clients/${A.id}`, { name: 'Otro' })).status, 409);
check('cerrado: sin transiciones', (await lec.call('GET', `/v1/clients/${A.id}`)).body.allowed_transitions.length, 0);
check('cerrado: no nueva lista blanca → 409', (await tes.call('POST', '/v1/wallets', { client_id: A.id, chain: 'ethereum', network: 'eth-sepolia', address: addr(), purpose: 'withdrawal_whitelist' })).status, 409);
check('cerrado: no dirección de depósito → 409', (await opr.call('POST', `/v1/clients/${A.id}/deposit-address`, {})).status, 409);

// ── Wallets: desactivar/reactivar (tesorero)
check('operador no desactiva wallet → 403', (await opr.call('PATCH', `/v1/wallets/${wl.body.id}`, { active: false })).status, 403);
check('tesorero desactiva wallet', (await tes.call('PATCH', `/v1/wallets/${wl.body.id}`, { active: false })).body.active, false);

// ── Cuentas y dirección de depósito desde la consola
const C = (await opr.call('POST', '/v1/clients', { name: `Cliente C ${R}` }, { 'idempotency-key': `c-${R}` })).body;
check('operador abre cuenta', (await opr.call('POST', `/v1/clients/${C.id}/accounts`, { asset_id: 'USDC-ETH-SEPOLIA' })).status, 201);
const da = await opr.call('POST', `/v1/clients/${C.id}/deposit-address`, {});
check('operador genera dirección de depósito', da.status, 201);
check('rotar da otra dirección', (await opr.call('POST', `/v1/clients/${C.id}/deposit-address`, { rotate: true })).body.address !== da.body.address, true);
check('wallets del cliente (2 depósito)', (await lec.call('GET', `/v1/wallets?client_id=${C.id}`)).body.wallets.filter((w) => w.purpose === 'deposit').length, 2);
check('postings de cuenta por id', (await lec.call('GET', `/v1/accounts/${ACC_A}/postings?limit=2`)).body.postings.length, 2);

console.log(`\n${ok} ok, ${fail} fallos`);
process.exit(fail ? 1 : 0);
