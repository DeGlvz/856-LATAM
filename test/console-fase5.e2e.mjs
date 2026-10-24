// E2E fase 5: 2FA (TOTP), autorización individual de retiros, doble aprobación de corridas, bitácora y restablecimiento de 2FA.
// Uso: BASE KEY RPC_URL FUNDER_PK BOOT_EMAIL BOOT_PASS node test/console-fase5.e2e.mjs
// API local con COOKIE_SECURE=false, WORKER_ENABLED=true, intervalo 1000 ms, CONFIRMATIONS=1, DUAL_APPROVAL=console, APPROVAL_REQUIRE_2FA=true,
// TOTP_ENCRYPTION_KEY definida y firmante de prueba contra una cadena LOCAL (Hardhat/Anvil).
import { execFileSync } from 'node:child_process';
import { createPublicClient, createWalletClient, http, parseEther } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { localChain, workerDriver } from './lib/worker.mjs';
import { totp } from './lib/totp.mjs';

const { BASE, KEY, RPC_URL, FUNDER_PK, BOOT_EMAIL, BOOT_PASS } = process.env;
const hardhat = await localChain(RPC_URL);
const worker = workerDriver({ BASE, KEY });
const pub = createPublicClient({ chain: hardhat, transport: http(RPC_URL) });
const funder = createWalletClient({ account: privateKeyToAccount(FUNDER_PK), chain: hardhat, transport: http(RPC_URL) });
const AS = 'USDC-ETH-SEPOLIA', ETH = 'ETH-SEPOLIA';
const R = Math.random().toString(36).slice(2, 8);
const NET = `10.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`;
let ok = 0, fail = 0;
const check = (n, got, want) => { if (String(got) === String(want)) { ok++; console.log('✔', n); } else { fail++; console.log(`✘ ${n} — esperado ${want}, obtenido ${got}`); } };

function browser(ip) {
  let cookie = null;
  const call = async (method, path, body, extra = {}) => {
    const r = await fetch(BASE + path, { method, headers: { 'x-forwarded-for': ip, ...(body ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}), ...(method !== 'GET' ? { 'x-856-console': '1' } : {}), ...extra }, body: body && JSON.stringify(body) });
    const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
    return { status: r.status, body: await r.json().catch(() => null), cookie: !!sc };
  };
  return { call, login: (e, p) => call('POST', '/v1/auth/login', { email: e, password: p }), forget: () => { cookie = null; } };
}
const key = async (method, path, body, idem) => {
  const r = await fetch(BASE + path, { method, headers: { 'x-api-key': KEY, 'content-type': 'application/json', ...(idem ? { 'idempotency-key': `${idem}-${R}` } : {}) }, body: body && JSON.stringify(body) });
  return { status: r.status, body: await r.json() };
};
const createOperator = (email, role, pw) => execFileSync('node', ['dist/scripts/create-operator.js', email, role], { input: pw + '\n', env: process.env, stdio: ['pipe', 'pipe', 'ignore'] });
const idem = (k) => ({ 'idempotency-key': `${k}-${R}` });

const tes = browser(`${NET}.1`); check('login tesorero 1', (await tes.login(BOOT_EMAIL, BOOT_PASS)).status, 200);
const T2 = `tes5-${R}@ejemplo.mx`, PW2 = 'clave-tesorero2-123';
createOperator(T2, 'tesorero', PW2);
createOperator(`op5-${R}@ejemplo.mx`, 'ejecutivo', 'clave-operador-123');
createOperator(`lec5-${R}@ejemplo.mx`, 'lectura', 'clave-lectura-123');
const opr = browser(`${NET}.2`); await opr.login(`op5-${R}@ejemplo.mx`, 'clave-operador-123');
const lec = browser(`${NET}.3`); await lec.login(`lec5-${R}@ejemplo.mx`, 'clave-lectura-123');
const t2 = browser(`${NET}.4`);

// ═════ 2FA ═════
check('tesorero 2 sin 2FA entra solo con contraseña', (await t2.login(T2, PW2)).status, 200);
check('  …me: totp_enabled = false', (await t2.call('GET', '/v1/auth/me')).body.operator.totp_enabled, false);
const setup = (await t2.call('POST', '/v1/auth/totp/setup', {})).body;
check('setup devuelve secreto y otpauth://', `${/^[A-Z2-7]{32}$/.test(setup.secret)} ${setup.otpauth_url.startsWith('otpauth://totp/')}`, 'true true');
const otp = totp(setup.secret);
check('activar con código incorrecto → 422', (await t2.call('POST', '/v1/auth/totp/enable', { code: otp.wrong() })).status, 422);
check('activar con código correcto', (await t2.call('POST', '/v1/auth/totp/enable', { code: await otp.next() })).body.totp_enabled, true);
check('setup otra vez con 2FA activo → 409', (await t2.call('POST', '/v1/auth/totp/setup', {})).status, 409);

await t2.call('POST', '/v1/auth/logout', {}); t2.forget();
let lg = await t2.login(T2, PW2);
check('login con 2FA: pide código y no abre sesión', `${lg.body.mfa_required} ${lg.cookie}`, 'true false');
check('  …sin sesión todavía → 401', (await t2.call('GET', '/v1/auth/me')).status, 401);
check('código incorrecto → 401', (await t2.call('POST', '/v1/auth/login/totp', { mfa_token: lg.body.mfa_token, code: otp.wrong() })).status, 401);
const c1 = await otp.next();
const ok2 = await t2.call('POST', '/v1/auth/login/totp', { mfa_token: lg.body.mfa_token, code: c1 });
check('código correcto → sesión', `${ok2.status} ${ok2.cookie} ${ok2.body.operator?.totp_enabled}`, '200 true true');
check('  …el reto no se reutiliza', (await t2.call('POST', '/v1/auth/login/totp', { mfa_token: lg.body.mfa_token, code: c1 })).status, 401);
const t2b = browser(`${NET}.5`); lg = await t2b.login(T2, PW2);
check('mismo código en otro login (replay) → 401', (await t2b.call('POST', '/v1/auth/login/totp', { mfa_token: lg.body.mfa_token, code: c1 })).status, 401);

// ═════ Instrucciones internas directas y autorización de solicitudes API ═════
const cl = (await opr.call('POST', '/v1/clients', { name: `F5 Cliente ${R}`, assets: [ETH, AS] }, idem('cl'))).body;
await opr.call('PATCH', `/v1/clients/${cl.id}`, { status: 'active' });
const DEST = privateKeyToAccount(generatePrivateKey()).address;
await tes.call('POST', '/v1/wallets', { client_id: cl.id, chain: 'ethereum', network: 'eth-sepolia', address: DEST, purpose: 'withdrawal_whitelist' });
const accEth = (await tes.call('GET', `/v1/clients/${cl.id}`)).body.accounts.find((a) => a.asset_id === ETH).id;
await tes.call('POST', '/v1/entries', { kind: 'deposit', postings: [
  { account: `system:${ETH}:custody`, direction: 'debit', amount: '50000000000000000' }, { account: accEth, direction: 'credit', amount: '50000000000000000' }] }, idem('fund'));
// Hot wallet con gas real en la cadena local y cuadrada en el libro
const hot = (await tes.call('GET', '/v1/treasury/hot-wallet')).body.address;
await pub.waitForTransactionReceipt({ hash: await funder.sendTransaction({ to: hot, value: parseEther('1') }) });
const gap = BigInt((await tes.call('GET', '/v1/treasury/hot-wallet')).body.balances.find((b) => b.asset_id === ETH).difference);
if (gap > 0n) await tes.call('POST', '/v1/entries', { kind: 'adjustment', postings: [
  { account: `system:${ETH}:custody`, direction: 'debit', amount: gap.toString() }, { account: `system:${ETH}:equity`, direction: 'credit', amount: gap.toString() }] }, idem('gap'));
const bal = async () => (await tes.call('GET', `/v1/accounts/${accEth}`)).body.balance;

const w1 = (await tes.call('POST', '/v1/withdrawals', { client_id: cl.id, asset_id: ETH, to_address: DEST, amount: '10000000000000000' }, idem('w1'))).body;
check('instrucción de consola queda lista para ejecución directa', `${w1.status} ${w1.approval_status} ${w1.requested_by}`, `reserved not_required ${BOOT_EMAIL.toLowerCase()}`);
check('  …saldo reservado al pedirlo', await bal(), '40000000000000000');
await worker.run(cl.id);
check('worker ejecuta instrucción de consola sin aprobación adicional', ['signed', 'broadcast', 'confirmed'].includes((await lec.call('GET', `/v1/withdrawals/${w1.id}`)).body.status), true);

const wk = (await key('POST', '/v1/withdrawals', { client_id: cl.id, asset_id: ETH, to_address: DEST, amount: '1000' }, 'wk')).body;
check('solicitud de integración requiere autorización', wk.approval_status, 'pending');
const ap = (await lec.call('GET', '/v1/approvals')).body;
check('la solicitud de integración aparece en la cola', ap.withdrawals.some((w) => w.id === wk.id), true);
const noCode = await t2.call('POST', `/v1/withdrawals/${wk.id}/approve`, {});
check('aprobar sin código 2FA → 400', `${noCode.status} ${noCode.body.code}`, '400 totp_code_required');
check('aprobar con código incorrecto → 422', (await t2.call('POST', `/v1/withdrawals/${wk.id}/approve`, { code: otp.wrong() })).status, 422);
const apw = (await t2.call('POST', `/v1/withdrawals/${wk.id}/approve`, { code: await otp.next() })).body;
check('tesorero autoriza con una sola aprobación', `${apw.approval_status} ${apw.approved_by}`, `approved ${T2}`);
check('aprobar dos veces → 409', (await t2.call('POST', `/v1/withdrawals/${wk.id}/approve`, { code: await otp.next() })).status, 409);
await worker.run(cl.id);
check('el worker ejecuta la solicitud API autorizada', ['signed', 'broadcast', 'confirmed'].includes((await lec.call('GET', `/v1/withdrawals/${wk.id}`)).body.status), true);

const balanceBeforeReject = await bal();
const w2 = (await key('POST', '/v1/withdrawals', { client_id: cl.id, asset_id: ETH, to_address: DEST, amount: '5000000000000000' }, 'w2')).body;
const noT = await tes.call('POST', `/v1/withdrawals/${w2.id}/approve`, { code: '123456' });
check('aprobador sin 2FA activo → 403 totp_required', `${noT.status} ${noT.body.code}`, '403 totp_required');
check('rechazar sin motivo → 400', (await tes.call('POST', `/v1/withdrawals/${w2.id}/reject`, {})).status, 400);
const rj = (await tes.call('POST', `/v1/withdrawals/${w2.id}/reject`, { reason: 'Destino no confirmado' })).body;
check('rechazado: cancelado con motivo y autor', `${rj.status} ${rj.approval_status} ${rj.rejected_by} ${rj.rejected_reason}`, `cancelled rejected ${BOOT_EMAIL.toLowerCase()} Destino no confirmado`);
check('  …saldo devuelto', await bal(), balanceBeforeReject);
// ═════ Doble aprobación de corridas ═════
const mk = async (n) => { const c = (await opr.call('POST', '/v1/clients', { name: `F5 ${n} ${R}`, assets: [AS] }, idem(`c${n}`))).body; await opr.call('PATCH', `/v1/clients/${c.id}`, { status: 'active' }); return c; };
const [A, B, C] = [await mk('A'), await mk('B'), await mk('C')];
const accA = (await tes.call('GET', `/v1/clients/${A.id}`)).body.accounts[0].id;
await tes.call('POST', '/v1/entries', { kind: 'deposit', postings: [
  { account: `system:${AS}:custody`, direction: 'debit', amount: '50000000' }, { account: accA, direction: 'credit', amount: '50000000' }] }, idem('fA'));
const ob = (d, c, amount, ref) => opr.call('POST', '/v1/obligations', { debtor_id: d.id, creditor_id: c.id, asset_id: AS, amount, external_ref: ref }, idem(ref));
await ob(A, B, '30000000', `N1-${R}`); await ob(B, C, '20000000', `N2-${R}`);
const ids = (await lec.call('GET', `/v1/obligations?external_ref=N&status=open&asset_id=${AS}&limit=1000`)).body.obligations.filter((o) => o.external_ref.endsWith(R)).map((o) => o.id);
const pv = (await opr.call('POST', '/v1/netting/preview', { asset_id: AS, obligation_ids: ids })).body;
const req1 = await tes.call('POST', '/v1/netting/runs', { asset_id: AS, obligation_ids: ids, expected_net_amount: pv.net_amount }, idem('r1'));
check('corrida desde consola → 202 pendiente', `${req1.status} ${req1.body.status}`, '202 pending_approval');
check('  …obligaciones siguen abiertas', (await lec.call('GET', `/v1/obligations?netting_run_id=${req1.body.id}`)).body.obligations.length, 0);
check('  …detalle trae simulación vigente y liquidable', `${req1.body.preview.can_settle} ${req1.body.obligations.length}`, 'true 2');
check('aparece en la cola', (await lec.call('GET', '/v1/approvals')).body.netting_runs.some((r) => r.id === req1.body.id), true);
check('quien solicitó no aprueba la corrida → 403', (await tes.call('POST', `/v1/netting/runs/${req1.body.id}/approve`, { code: '000000' })).body.code, 'same_operator');
const apr = (await t2.call('POST', `/v1/netting/runs/${req1.body.id}/approve`, { code: await otp.next() })).body;
check('tesorero 2 aprueba → liquidada', `${apr.status} ${apr.approved_by} ${!!apr.entry_id}`, `settled ${T2} true`);
const bA = (await tes.call('GET', `/v1/accounts/${accA}`)).body.balance;
check('  …saldo de A = 50 − 30', bA, '20000000');

await ob(A, C, '1000000', `N3-${R}`); await ob(C, B, '500000', `N4-${R}`);
const ids2 = (await lec.call('GET', `/v1/obligations?status=open&asset_id=${AS}&limit=1000`)).body.obligations.filter((o) => o.external_ref?.endsWith(R)).map((o) => o.id);
const pv2 = (await opr.call('POST', '/v1/netting/preview', { asset_id: AS, obligation_ids: ids2 })).body;
const req2 = (await tes.call('POST', '/v1/netting/runs', { asset_id: AS, obligation_ids: ids2, expected_net_amount: pv2.net_amount }, idem('r2'))).body;
await opr.call('POST', `/v1/obligations/${ids2[0]}/cancel`, { reason: 'Factura anulada' });
const bad = await t2.call('POST', `/v1/netting/runs/${req2.id}/approve`, { code: await otp.next() });
check('obligación cancelada tras solicitar → 422 y no se liquida', `${bad.status} ${bad.body.code}`, '422 obligations_not_open');
const after = (await lec.call('GET', `/v1/netting/runs/${req2.id}`)).body;
check('  …sigue pendiente con el error visible', `${after.status} ${!!after.last_error} ${after.preview.can_settle}`, 'pending_approval true false');
const rr = (await tes.call('POST', `/v1/netting/runs/${req2.id}/reject`, { reason: 'Alcance cambió' })).body;
check('rechazar corrida', `${rr.status} ${rr.rejected_by}`, `rejected ${BOOT_EMAIL.toLowerCase()}`);
check('historial filtra por estado', (await lec.call('GET', `/v1/netting/runs?status=rejected&asset_id=${AS}`)).body.runs.some((r) => r.id === req2.id), true);

// ═════ Bitácora ═════
check('lectura no ve la bitácora → 403', (await lec.call('GET', '/v1/audit')).status, 403);
check('operador no ve la bitácora → 403', (await opr.call('GET', '/v1/audit')).status, 403);
const au = (await tes.call('GET', `/v1/audit?action=${encodeURIComponent('POST /v1/withdrawals/:id/approve')}&limit=50`)).body;
check('bitácora: aprobación por tesorero 2', au.entries.some((e) => e.actor === T2 && e.status === 200 && e.target === wk.id), true);
check('bitácora: intento de autoaprobación (403)', au.entries.some((e) => e.actor === BOOT_EMAIL.toLowerCase() && e.status === 403), true);
const rjAu = (await tes.call('GET', `/v1/audit?target=${w2.id}&limit=50`)).body.entries.find((e) => e.action.endsWith('/reject'));
check('bitácora guarda el motivo del rechazo', rjAu?.metadata?.reason, 'Destino no confirmado');
check('bitácora: login con 2FA', (await tes.call('GET', `/v1/audit?action=login&actor=${T2}`)).body.entries.some((e) => e.metadata?.mfa === true), true);
check('bitácora: código fallido registrado', (await tes.call('GET', `/v1/audit?action=login_mfa_failed&actor=${T2}`)).body.entries.length >= 1, true);
const pg1 = (await tes.call('GET', '/v1/audit?limit=3')).body;
const pg2 = (await tes.call('GET', `/v1/audit?limit=3&cursor=${pg1.next_cursor}`)).body;
check('paginación por cursor', `${pg1.entries.length} ${pg2.entries[0].id < pg1.entries[2].id}`, '3 true');
check('catálogo de acciones', (await tes.call('GET', '/v1/audit/actions')).body.actions.some((a) => a.action === 'totp_enabled'), true);

// ═════ Restablecer 2FA ═════
const ops = (await tes.call('GET', '/v1/operators')).body.operators;
const o2 = ops.find((o) => o.email === T2);
check('lista de operadores con estado 2FA', o2.totp_enabled, true);
const me1 = ops.find((o) => o.email === BOOT_EMAIL.toLowerCase());
check('no puede restablecer su propio 2FA → 409', (await tes.call('POST', `/v1/operators/${me1.id}/totp/reset`, { reason: 'Prueba propia' })).status, 409);
check('restablecer 2FA de otro (motivo)', (await tes.call('POST', `/v1/operators/${o2.id}/totp/reset`, { reason: 'Teléfono perdido' })).status, 200);
check('  …sus sesiones quedan cerradas', (await t2.call('GET', '/v1/auth/me')).status, 401);
check('  …vuelve a entrar solo con contraseña', (await browser(`${NET}.6`).login(T2, PW2)).body.operator?.totp_enabled, false);

console.log(`\n${ok} ok, ${fail} fallos`);
process.exit(fail ? 1 : 0);
