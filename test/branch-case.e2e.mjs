// E2E Terminal de Caja / Branch Case (PR1: migración + servicio + API de consola, sin UI ni portal).
// Uso: BASE BOOT_EMAIL BOOT_PASS DATABASE_URL node test/branch-case.e2e.mjs
// API con COOKIE_SECURE=false, BRANCH_CREDIT_ENABLED=true, BRANCH_CLIENT_SIGN_REQUIRED=false (los casos con firma se piden con
// client_required=true y la firma del cliente se simula por SQL: el portal llega en PR2), ORIGIN_RULE=off y APPROVAL_REQUIRE_2FA=true.
import { execFileSync } from 'node:child_process';
import pg from 'pg';
import { makeApprover } from './lib/approver.mjs';

const { BASE, BOOT_EMAIL, BOOT_PASS, DATABASE_URL } = process.env;
const db = new pg.Client({ connectionString: DATABASE_URL });
await db.connect();
const R = Math.random().toString(36).slice(2, 8);
const NET = `10.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`;
const ASSET = 'USDC-ETH-SEPOLIA';
let ok = 0, fail = 0;
const check = (n, got, want) => { if (String(got) === String(want)) { ok++; console.log('✔', n); } else { fail++; console.log(`✘ ${n} — esperado ${want}, obtenido ${got}`); } };

function browser(ip) {
  let cookie = null;
  const call = async (method, path, body, extra = {}) => {
    const r = await fetch(BASE + path, { method, headers: { 'x-forwarded-for': ip, ...(body ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}), ...(method !== 'GET' ? { 'x-856-console': '1' } : {}), ...extra }, body: body && JSON.stringify(body) });
    const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
    return { status: r.status, headers: r.headers, body: await r.json().catch(() => null) };
  };
  return { call, login: (e, p) => call('POST', '/v1/auth/login', { email: e, password: p }) };
}
const createOperator = (email, role, pw) => execFileSync('node', ['dist/scripts/create-operator.js', email, role], { input: pw + '\n', env: process.env, stdio: ['pipe', 'pipe', 'ignore'] });

const tes = browser(`${NET}.1`); check('login tesorero', (await tes.login(BOOT_EMAIL, BOOT_PASS)).status, 200);
createOperator(`caja-${R}@ejemplo.mx`, 'ejecutivo', 'clave-ejecutivo-123');
const exe = browser(`${NET}.2`); await exe.login(`caja-${R}@ejemplo.mx`, 'clave-ejecutivo-123');
const ap1 = await makeApprover({ BASE, ip: `${NET}.3`, tag: `bc1-${R}` });
const ap2 = await makeApprover({ BASE, ip: `${NET}.4`, tag: `bc2-${R}` });

const P = '/v1/console/branch-cases';
const bal = async (code) => (await tes.call('GET', `/v1/accounts/${code}`)).body.balance;
const newClient = async (name) => {
  const cl = (await exe.call('POST', '/v1/clients', { name: `${name} ${R}`, assets: [ASSET] }, { 'idempotency-key': `bc-c-${name}-${R}` })).body;
  await exe.call('PATCH', `/v1/clients/${cl.id}`, { status: 'active' });
  return (await exe.call('GET', `/v1/clients/${cl.id}`)).body;
};
const A = await newClient('Caja A'), B = await newClient('Caja B'), C = await newClient('Caja C');
const accA = `client:${A.id}:${ASSET}:available`, accB = `client:${B.id}:${ASSET}:available`;
const reserveA = `client:${A.id}:${ASSET}:reserve`;
await db.query(`INSERT INTO accounts (code, client_id, asset_id, type, normal_side, name) VALUES ($1,$2,$3,'liability','credit','Reserva')`, [reserveA, A.id, ASSET]);
const idem = (n) => ({ 'idempotency-key': `bc-${n}-${R}` });
const credit = (client, amount, extra = {}) => ({ client_id: client, reason: 'instrucción verbal de prueba', kind: 'fund_load', lines: [{ op_type: 'credit_available', asset_id: ASSET, amount, external_ref: 'EV-' + amount, memo: 'depósito en ventanilla' }], ...extra });
const count = async (t, w = 'true') => Number((await db.query(`SELECT count(*) FROM ${t} WHERE ${w}`)).rows[0].count);

// ── Crear, simular, idempotencia
const before = await count('branch_cases', `client_id = '${A.id}'`);
const sim = await exe.call('POST', P, credit(A.id, '1000000'), { 'x-856-simulate': 'true' });
check('simulación → 200 validated', `${sim.status}/${sim.body.status}`, '200/validated');
check('simulación no persiste nada', await count('branch_cases', `client_id = '${A.id}'`), before);
const simBad = await exe.call('POST', P, { client_id: A.id, reason: 'instrucción verbal de prueba', kind: 'fund_load', lines: [{ op_type: 'credit_available', asset_id: ASSET, amount: '1.5' }] }, { 'x-856-simulate': 'true' });
check('simulación con monto decimal → 422 {errors}', `${simBad.status}/${simBad.body.errors?.[0]?.linea}/${simBad.body.errors?.[0]?.campo}`, '422/1/amount');
const noReason = await exe.call('POST', P, { ...credit(A.id, '10'), reason: undefined }, { 'x-856-simulate': 'true' });
check('sin firma y sin motivo → 422 reason', `${noReason.status}/${noReason.body.errors?.[0]?.campo}`, '422/reason');
const noEv = await exe.call('POST', P, { ...credit(A.id, '10'), lines: [{ op_type: 'credit_available', asset_id: ASSET, amount: '10' }] }, { 'x-856-simulate': 'true' });
check('crédito sin external_ref → 422', `${noEv.status}/${noEv.body.errors?.[0]?.campo}`, '422/external_ref');
const badSrc = await exe.call('POST', P, { ...credit(A.id, '10'), source_account: `client:${A.id}:${ASSET}:available` }, { 'x-856-simulate': 'true' });
check('source_account no system → 422', `${badSrc.status}/${badSrc.body.errors?.[0]?.campo}`, '422/source_account');

const c1 = await exe.call('POST', P, credit(A.id, '1000000'), idem('c1'));
check('crear caso → 201 draft', `${c1.status}/${c1.body.status}`, '201/draft');
check('payload_hash sha256', /^[0-9a-f]{64}$/.test(c1.body.payload_hash), true);
const replay = await exe.call('POST', P, credit(A.id, '1000000'), idem('c1'));
check('replay de idempotencia → mismo caso', `${replay.headers.get('idempotent-replayed')}/${replay.body.id === c1.body.id}`, 'true/true');
check('replay no duplica', await count('branch_cases', `client_id = '${A.id}'`), before + 1);
check('Idempotency-Key con otro cuerpo → 422', (await exe.call('POST', P, credit(A.id, '2'), idem('c1'))).status, 422);
check('sin Idempotency-Key → 400', (await exe.call('POST', P, credit(A.id, '1000000'))).status, 400);
const dec = await exe.call('POST', P, { ...credit(A.id, '1000000'), lines: [{ op_type: 'debit_adjustment', asset_id: ASSET, amount: '1' }], kind: 'mixed' }, idem('adj'));
check('debit_adjustment rechazado (P2)', dec.status, 422);
const other = await exe.call('POST', P, { client_id: A.id, reason: 'instrucción verbal de prueba', kind: 'internal_transfer', lines: [{ op_type: 'internal_transfer', asset_id: ASSET, amount: '1', from_account_ref: accA, to_account_ref: accB }] }, idem('xclient'));
check('transferencia a cuenta de otro cliente rechazada', `${other.status}/${other.body.errors?.[0]?.campo}`, '422/to_account_ref');
const cp = await exe.call('POST', P, { client_id: A.id, reason: 'instrucción verbal de prueba', kind: 'payment_order', lines: [{ op_type: 'payment_order', asset_id: ASSET, amount: '1', counterparty_code: '856-ZZZZ-ZZZZ' }] }, idem('badcp'));
check('contraparte inexistente rechazada', `${cp.status}/${cp.body.errors?.[0]?.campo}`, '422/counterparty_code');

// ── Aislamiento por cliente y lista
const listA = (await exe.call('GET', `${P}?client_id=${A.id}`)).body;
check('lista por cliente solo trae casos de ese cliente', listA.cases.length > 0 && listA.cases.every((x) => x.client_id === A.id), true);
check('lista de otro cliente vacía', (await exe.call('GET', `${P}?client_id=${C.id}`)).body.cases.length, 0);
check('lista con next_cursor', 'next_cursor' in listA, true);
const det = (await exe.call('GET', `${P}/${c1.body.id}`)).body;
check('detalle con líneas', `${det.lines.length}/${det.lines[0].status}`, '1/pending');

// ── Nada se postea antes de aprobar; payload inmutable
check('saldo intacto antes de aprobar', await bal(accA), '0');
check('aprobar un borrador → 409', (await ap1.call('POST', `${P}/${c1.body.id}/approve`, { code: await ap1.code() })).status, 409);
const sub = await exe.call('POST', `${P}/${c1.body.id}/submit`, {});
check('submit → pending_treasury', sub.body.status, 'pending_treasury');
check('saldo intacto tras submit', await bal(accA), '0');
let immut = 'sin error';
try { await db.query(`UPDATE branch_cases SET payload_json = jsonb_set(payload_json, '{kind}', '"mixed"') WHERE id = $1`, [c1.body.id]); } catch (e) { immut = e.code; }
check('payload inmutable tras submit (trigger 23514)', immut, '23514');
immut = 'sin error';
try { await db.query(`UPDATE branch_case_lines SET amount = '9' WHERE branch_case_id = $1`, [c1.body.id]); } catch (e) { immut = e.code; }
check('líneas inmutables tras submit (trigger 23514)', immut, '23514');
check('submit repetido → 409', (await exe.call('POST', `${P}/${c1.body.id}/submit`, {})).status, 409);

// ── Doble aprobación y 2FA
check('ejecutivo no aprueba (rol) → 403', (await exe.call('POST', `${P}/${c1.body.id}/approve`, { code: '123456' })).status, 403);
const ownTes = await tes.call('POST', P, credit(A.id, '5'), idem('own'));
await tes.call('POST', `${P}/${ownTes.body.id}/submit`, {});
const same = await tes.call('POST', `${P}/${ownTes.body.id}/approve`, { code: '123456' });
check('quien preparó no aprueba → 403 same_operator', `${same.status}/${same.body.code}`, '403/same_operator');
check('sin código 2FA → 400', (await ap1.call('POST', `${P}/${c1.body.id}/approve`, {})).status, 400);
check('código 2FA incorrecto → 422', (await ap1.call('POST', `${P}/${c1.body.id}/approve`, { code: '000000' })).status, 422);
check('saldo intacto tras intentos fallidos', await bal(accA), '0');

// ── Aprobar con TOTP: crédito
const ap = await ap1.call('POST', `${P}/${c1.body.id}/approve`, { code: await ap1.code() });
check('aprobar con TOTP → applied', `${ap.status}/${ap.body.status}`, '200/applied');
check('crédito aplicado al saldo', await bal(accA), '1000000');
check('caso registra asiento y línea aplicada', `${ap.body.applied_entry_ids.length}/${ap.body.lines[0].status}`, '1/applied');
const entry = (await db.query(`SELECT kind, idempotency_key FROM journal_entries WHERE id = $1`, [ap.body.applied_entry_ids[0]])).rows[0];
check('asiento kind branch_credit con llave por línea', `${entry.kind}/${entry.idempotency_key}`, `branch_credit/branchcase:${c1.body.id}:1`);
check('aprobar de nuevo → 409', (await ap1.call('POST', `${P}/${c1.body.id}/approve`, { code: await ap1.code() })).status, 409);
check('cancelar un caso aplicado → 409', (await exe.call('POST', `${P}/${c1.body.id}/cancel`, { reason: 'ya aplicado' })).status, 409);

// ── Transferencia interna entre cuentas del mismo cliente
const t1 = await exe.call('POST', P, { client_id: A.id, reason: 'instrucción verbal de prueba', kind: 'internal_transfer', lines: [{ op_type: 'internal_transfer', asset_id: ASSET, amount: '400000', from_account_ref: accA, to_account_ref: reserveA }] }, idem('t1'));
check('crear transferencia → 201', t1.status, 201);
await exe.call('POST', `${P}/${t1.body.id}/submit`, {});
const t1a = await ap1.call('POST', `${P}/${t1.body.id}/approve`, { code: await ap1.code() });
check('transferencia aplicada', `${t1a.body.status}/${t1a.body.applied_transfer_ids.length}`, 'applied/1');
check('saldo origen tras transferencia', await bal(accA), '600000');
check('saldo destino tras transferencia', await bal(reserveA), '400000');

// ── Orden de pago: el cliente es deudor, la contraparte acreedora
const pay = await exe.call('POST', P, { client_id: A.id, reason: 'instrucción verbal de prueba', kind: 'payment_order', mandate_ref: `MND-${R}`, lines: [{ op_type: 'payment_order', asset_id: ASSET, amount: '250000', counterparty_code: B.counterparty_code, external_ref: `OC-${R}`, memo: 'proveedor' }] }, idem('pay'));
check('crear orden de pago → 201', pay.status, 201);
await exe.call('POST', `${P}/${pay.body.id}/submit`, {});
const paya = await ap2.call('POST', `${P}/${pay.body.id}/approve`, { code: await ap2.code() });
check('orden de pago aplicada', `${paya.body.status}/${paya.body.applied_obligation_ids.length}`, 'applied/1');
const ob = (await db.query(`SELECT debtor_id, creditor_id, amount::text AS amount, status, origin_kind, origin_ref FROM obligations WHERE id = $1`, [paya.body.applied_obligation_ids[0]])).rows[0];
check('obligación: cliente deudor, contraparte acreedora', `${ob.debtor_id === A.id}/${ob.creditor_id === B.id}`, 'true/true');
check('obligación origen branch_mandate con origin_ref = id del caso', `${ob.origin_kind}/${ob.origin_ref}/${ob.amount}`, `branch_mandate/${paya.body.id}/250000`);
check('la orden de pago no mueve saldo', await bal(accA), '600000');

// ── Saldo insuficiente: ROLLBACK total, sigue pending_treasury
const bad = await exe.call('POST', P, { client_id: A.id, reason: 'instrucción verbal de prueba', kind: 'mixed', lines: [
  { op_type: 'credit_available', asset_id: ASSET, amount: '500', external_ref: 'EV-500' },
  { op_type: 'internal_transfer', asset_id: ASSET, amount: '99999999', from_account_ref: accA, to_account_ref: reserveA },
] }, idem('bad'));
check('crear caso mixto → 201', bad.status, 201);
await exe.call('POST', `${P}/${bad.body.id}/submit`, {});
const bada = await ap1.call('POST', `${P}/${bad.body.id}/approve`, { code: await ap1.code() });
check('saldo insuficiente → 422', `${bada.status}/${bada.body.code}`, '422/insufficient_funds');
check('rollback total: el crédito de la línea 1 no persiste', await bal(accA), '600000');
const badd = (await exe.call('GET', `${P}/${bad.body.id}`)).body;
check('el caso sigue pending_treasury con last_error', `${badd.status}/${/línea 2/.test(badd.last_error)}`, 'pending_treasury/true');
check('línea fallida marcada', `${badd.lines[0].status}/${badd.lines[1].status}`, 'pending/failed');
check('sin asientos del caso fallido', await count('journal_entries', `idempotency_key LIKE 'branchcase:${bad.body.id}:%'`), 0);
const rej = await ap1.call('POST', `${P}/${bad.body.id}/reject`, { reason: 'fondos insuficientes' });
check('tesorero rechaza → rejected', `${rej.status}/${rej.body.status}/${rej.body.reject_reason}`, '200/rejected/fondos insuficientes');
check('ejecutivo no rechaza (rol) → 403', (await exe.call('POST', `${P}/${bad.body.id}/reject`, { reason: 'no puedo' })).status, 403);

// ── Aprobación concurrente: un solo apply
const cc = await exe.call('POST', P, credit(A.id, '700000'), idem('cc'));
await exe.call('POST', `${P}/${cc.body.id}/submit`, {});
const [r1, r2] = await Promise.all([
  (async () => ap1.call('POST', `${P}/${cc.body.id}/approve`, { code: await ap1.code() }))(),
  (async () => ap2.call('POST', `${P}/${cc.body.id}/approve`, { code: await ap2.code() }))(),
]);
check('aprobación concurrente: una 200 y una 409', [r1.status, r2.status].sort().join('/'), '200/409');
check('crédito aplicado una sola vez', await bal(accA), '1300000');
check('un solo asiento para la línea', await count('journal_entries', `idempotency_key = 'branchcase:${cc.body.id}:1'`), 1);

// ── Cancelar, firma del cliente pendiente (client_required) y límites
const cx = await exe.call('POST', P, credit(A.id, '10'), idem('cx'));
const cxr = await exe.call('POST', `${P}/${cx.body.id}/cancel`, { reason: 'error de captura' });
check('cancelar borrador → cancelled', `${cxr.status}/${cxr.body.status}`, '200/cancelled');
check('motivo de cancelación obligatorio', (await exe.call('POST', `${P}/${cx.body.id}/cancel`, {})).status, 400);

const sg = await exe.call('POST', P, credit(A.id, '300', { client_required: true }), idem('sg'));
const sgs = await exe.call('POST', `${P}/${sg.body.id}/submit`, {});
check('client_required → pending_client', sgs.body.status, 'pending_client');
check('pending_client no avanza desde consola (aprobar → 409)', (await ap1.call('POST', `${P}/${sg.body.id}/approve`, { code: await ap1.code() })).status, 409);
await db.query(`UPDATE branch_cases SET status = 'pending_treasury', client_signed_at = now(), client_signature = 'sim' WHERE id = $1`, [sg.body.id]);
const sga = await ap1.call('POST', `${P}/${sg.body.id}/approve`, { code: await ap1.code() });
check('con firma del cliente simulada → applied', sga.body.status, 'applied');

const tooMany = await exe.call('POST', P, { client_id: A.id, reason: 'instrucción verbal de prueba', kind: 'fund_load', lines: Array.from({ length: 501 }, () => ({ op_type: 'credit_available', asset_id: ASSET, amount: '1' })) }, idem('many'));
check('más de BRANCH_MAX_LINES → 422', tooMany.status, 422);
await db.query(`UPDATE clients SET status = 'suspended' WHERE id = $1`, [C.id]);
check('cliente no activo → 422', (await exe.call('POST', P, credit(C.id, '1'), idem('susp'))).status, 422);

// ── Auditoría
const acts = (await db.query(`SELECT DISTINCT action FROM audit_log WHERE action LIKE 'branch_case_%' AND target = ANY($1)`, [[c1.body.id, bad.body.id, cx.body.id]])).rows.map((r) => r.action).sort().join(',');
check('auditoría de ciclo completo', acts, 'branch_case_applied,branch_case_approved,branch_case_cancelled,branch_case_created,branch_case_rejected,branch_case_submitted');

await db.end();
console.log(`\n${ok} ok, ${fail} fallos`);
process.exit(fail ? 1 : 0);
