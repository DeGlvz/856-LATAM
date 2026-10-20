// E2E rieles fiat: interruptores, cuentas cifradas con doble aprobación y visibilidad por cliente. Datos bancarios FICTICIOS.
// Uso: BASE KEY DATABASE_URL RPC_B FUNDER_PK EURE TOTP_ENCRYPTION_KEY node test/fiat-rails-toggle.e2e.mjs
//   API en sandbox como en fiat-f1.e2e.mjs, además con FIAT_RAILS_ENC_KEY (≥32 caracteres) configurada.
import { execFileSync } from 'node:child_process';
import pg from 'pg';
import { makeApprover } from './lib/approver.mjs';
import { totp } from './lib/totp.mjs';

const { BASE, KEY, DATABASE_URL, EURE } = process.env;
const R = Math.random().toString(36).slice(2, 8);
const NET = `10.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`;
let ok = 0, fail = 0;
const check = (n, got, want) => { if (String(got) === String(want)) { ok++; console.log('✔', n); } else { fail++; console.log(`✘ ${n} — esperado ${want}, obtenido ${got}`); } };
const db = new pg.Pool({ connectionString: DATABASE_URL });
const PW = 'clave-portal-12345';
const ASSET = `EURE-R${R.toUpperCase()}`;
const ACCOUNT = { beneficiary_name: `Beneficiario Ficticio ${R}`, bank_name: 'Banco Ficticio', account_number: '000123456789', aba: '021000021', swift: 'FICTUS33' };
const SECRETS = [ACCOUNT.account_number, ACCOUNT.aba, ACCOUNT.swift, ACCOUNT.beneficiary_name];

const api = async (method, path, body) => {
  const r = await fetch(BASE + path, { method, headers: { 'x-api-key': KEY, 'content-type': 'application/json' }, body: body && JSON.stringify(body) });
  return { status: r.status, body: await r.json().catch(() => null) };
};
function session(ip, prefix) {
  let cookie = null;
  const call = async (method, path, body) => {
    const r = await fetch(BASE + prefix + path, { method, headers: { 'x-forwarded-for': ip, ...(body ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}), ...(method !== 'GET' ? { [prefix === '/v1/portal' ? 'x-856-portal' : 'x-856-console']: '1' } : {}) }, body: body && JSON.stringify(body) });
    const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
    return { status: r.status, body: await r.json().catch(() => null) };
  };
  return { call };
}
async function portalUser(clientId, n) {
  const email = `rail-admin-${n}-${R}@ejemplo.mx`;
  const inv = (await api('POST', `/v1/clients/${clientId}/portal-invite`, { email })).body;
  const s = session(`${NET}.${n}`, '/v1/portal');
  await s.call('POST', '/invites/accept', { token: inv.link.split('#')[1], name: `Usuario ${n}`, password: PW });
  await s.call('POST', '/auth/login', { email, password: PW });
  const st = (await s.call('POST', '/auth/totp/setup', {})).body; // el rol admin exige 2FA
  await s.call('POST', '/auth/totp/enable', { code: await totp(st.secret).next() });
  return { s, email };
}

// ═════ Preparación
check('activo EURe de prueba', (await api('POST', '/v1/assets', { id: ASSET, symbol: 'EURe', chain: 'ethereum', network: 'base-sepolia', kind: 'erc20', contract_address: EURE, decimals: 18 })).status, 201);
await db.query(`UPDATE assets SET active = false WHERE symbol = 'EURe' AND network = 'base-sepolia' AND id <> $1`, [ASSET]);
const T1 = await makeApprover({ BASE, ip: `${NET}.20`, tag: `rt1-${R}` });
const T2 = await makeApprover({ BASE, ip: `${NET}.21`, tag: `rt2-${R}` });
const EJ = `ejec-rails-${R}@ejemplo.mx`;
execFileSync('node', ['dist/scripts/create-operator.js', EJ, 'ejecutivo'], { input: 'clave-ejecutivo-123\n', env: process.env, stdio: ['pipe', 'pipe', 'ignore'] });
const ej = session(`${NET}.22`, ''); await ej.call('POST', '/v1/auth/login', { email: EJ, password: 'clave-ejecutivo-123' });
const mk = async (name) => {
  const c = (await api('POST', '/v1/clients', { name: `${name} ${R}`, assets: [ASSET] })).body;
  await api('PATCH', `/v1/clients/${c.id}`, { status: 'active' });
  return c;
};
const A = await mk('Rieles Alfa'), B = await mk('Rieles Beta');
const uA = await portalUser(A.id, 2), uB = await portalUser(B.id, 3);
const audit = async (action, target) => (await db.query(`SELECT actor, metadata::text AS m FROM audit_log WHERE action = $1 AND target = $2 ORDER BY id DESC LIMIT 1`, [action, target])).rows[0];
const put = (t, id, body) => t.call('PUT', `/v1/console/fiat/rails/${id}`, body);

// ═════ 1. Permisos
check('lista de rieles: tesorero → 200', (await T1.call('GET', '/v1/console/fiat/rails')).status, 200);
check('lista de rieles: ejecutivo → 200', (await ej.call('GET', '/v1/console/fiat/rails')).status, 200);
check('lista de rieles: API_KEY global → 403', (await api('GET', '/v1/console/fiat/rails')).status, 403);
const body403 = { reason: 'prueba de permisos', is_enabled: true, code: '000000' };
const ejPut = await put(ej, 'wire-usd', body403);
check('apagar/encender por ejecutivo → 403 forbidden', `${ejPut.status} ${ejPut.body?.code}`, '403 forbidden');
const keyPut = await api('PUT', '/v1/console/fiat/rails/wire-usd', body403);
check('apagar/encender con API_KEY global → 403 forbidden', `${keyPut.status} ${keyPut.body?.code}`, '403 forbidden');
check('proponer cuenta por ejecutivo → 403', (await ej.call('POST', '/v1/console/fiat/rails/wire-usd/accounts', { reason: 'prueba', account: ACCOUNT, code: '000000' })).status, 403);
check('asignar cliente por ejecutivo → 403', (await ej.call('POST', '/v1/console/fiat/rails/wire-usd/clients', { reason: 'prueba', client_id: A.id, code: '000000' })).status, 403);
check('sin código 2FA → 422 bad_code', (await put(T1, 'wire-usd', { reason: 'sin código', maintenance_message: 'x' })).body?.code, 'bad_code');
check('sin motivo → 400', (await put(T1, 'wire-usd', { code: await T1.code(), is_enabled: false })).status, 400);

// ═════ 2. Un riel manual no se enciende sin cuenta activa
const noAcc = await put(T1, 'wire-usd', { code: await T1.code(), reason: 'encender sin cuenta', is_enabled: true });
check('encender sin cuenta activa → 409 rail_without_account', `${noAcc.status} ${noAcc.body?.code}`, '409 rail_without_account');

// ═════ 3. Cuenta cifrada con doble aprobación
const prop = await T1.call('POST', '/v1/console/fiat/rails/wire-usd/accounts', { code: await T1.code(), reason: 'alta de cuenta wire', account: ACCOUNT });
check('proponer cuenta → 201 versión 1', `${prop.status} ${prop.body?.version}`, '201 1');
check('  …la respuesta no devuelve valores completos', SECRETS.some((s) => JSON.stringify(prop.body).includes(s)), false);
const self = await T1.call('POST', `/v1/console/fiat/rails/wire-usd/accounts/${prop.body.version}/approve`, { code: await T1.code(), reason: 'autoaprobación' });
check('el mismo operador no puede aprobar → 403 forbidden', `${self.status} ${self.body?.code}`, '403 forbidden');
const badEx = await ej.call('POST', `/v1/console/fiat/rails/wire-usd/accounts/${prop.body.version}/approve`, { reason: 'ejecutivo', code: '000000' });
check('ejecutivo no aprueba → 403', badEx.status, 403);
const appr = await T2.call('POST', `/v1/console/fiat/rails/wire-usd/accounts/${prop.body.version}/approve`, { code: await T2.code(), reason: 'verificada contra carta del banco' });
check('un tesorero distinto aprueba → 200', appr.status, 200);
const encRow = (await db.query(`SELECT details_enc, last4, is_active FROM fiat_rail_accounts WHERE rail_id = 'wire-usd' AND version = $1`, [prop.body.version])).rows[0];
check('cifrado: ningún valor en claro en details_enc', SECRETS.some((s) => encRow.details_enc.includes(s)), false);
check('  …last4 visible y cuenta activa', `${encRow.last4} ${encRow.is_active}`, '6789 true');
const dump = (await db.query(`SELECT string_agg(metadata::text, ' ') AS m FROM audit_log WHERE action LIKE 'fiat_rail%'`)).rows[0].m ?? '';
check('auditoría sin valores completos de la cuenta', SECRETS.some((s) => dump.includes(s)), false);
const proposedEv = await audit('fiat_rail_account_proposed', 'wire-usd');
check('evento fiat_rail_account_proposed con last4 y sin valores', `${proposedEv?.actor === T1.email} ${proposedEv?.m.includes('6789')}`, 'true true');
check('evento fiat_rail_account_approved presente', (await audit('fiat_rail_account_approved', 'wire-usd'))?.actor, T2.email);
check('lista de consola enmascarada', JSON.stringify((await T1.call('GET', '/v1/console/fiat/rails')).body).includes(ACCOUNT.account_number), false);

// ═════ 4. Encender/apagar y efecto en el portal
const hidden = (await uA.s.call('GET', '/fiat/instructions')).body;
check('apagado: el cliente no ve el riel wire-usd', (hidden.active_rails ?? []).some((r) => r.rail_id === 'wire-usd'), false);
const on = await put(T1, 'wire-usd', { code: await T1.code(), reason: 'apertura del riel wire', is_enabled: true, recommended_for: 'Recomendado para montos grandes', settlement_time: '1 día hábil' });
check('encender con cuenta activa → 200', `${on.status} ${on.body?.rail?.is_enabled}`, '200 true');
const shown = (await uA.s.call('GET', '/fiat/instructions')).body;
const card = (shown.active_rails ?? []).find((r) => r.rail_id === 'wire-usd');
check('encendido: el cliente ve el riel con su MEMO (counterparty_code)', `${!!card} ${card?.memo && card.memo.length > 0}`, 'true true');
const cp = (await db.query('SELECT counterparty_code FROM clients WHERE id = $1', [A.id])).rows[0].counterparty_code;
check('  …el MEMO es el counterparty_code del cliente, sin nombres', card?.memo === cp && !String(card?.memo).includes('Alfa'), true);
check('  …el cliente ve la cuenta completa (la necesita para transferir)', JSON.stringify(card).includes(ACCOUNT.account_number), true);
const leak = JSON.stringify(shown);
check('  …sin datos internos (updated_by, version, details_enc, creador)', /updated_by|details_enc|approved_by|created_by|"version"/.test(leak), false);
const toggled = await audit('fiat_rail_toggled', 'wire-usd');
check('audit_log: fiat_rail_toggled con motivo y antes/después', `${toggled?.actor === T1.email} ${toggled?.m.includes('apertura del riel wire')} ${toggled?.m.includes('before')} ${toggled?.m.includes('after')}`, 'true true true true');
const off = await put(T1, 'wire-usd', { code: await T1.code(), reason: 'mantenimiento del banco', is_enabled: false, maintenance_message: 'Wire en mantenimiento, use otro riel.' });
check('apagar → 200', off.status, 200);
const after = (await uA.s.call('GET', '/fiat/instructions')).body;
check('apagado: desaparece de active_rails', (after.active_rails ?? []).some((r) => r.rail_id === 'wire-usd'), false);
check('  …y se informa mantenimiento', (after.unavailable_rails ?? []).some((r) => r.rail_id === 'wire-usd' && /mantenimiento/i.test(r.maintenance_message)), true);

// ═════ 5. Riel automático (Monerium) apagado bloquea intents; abiertos siguen vigentes
const su = await T1.call('POST', '/v1/console/fiat/setup', { code: await T1.code() });
check('alta de IBAN simulado → 200', su.status, 200);
await db.query(`UPDATE fiat_rails SET is_enabled = false, visibility = 'all' WHERE rail_id = 'monerium-eur'`);
const blocked = await uA.s.call('POST', '/fiat/payment-intents', { amount: '10' });
check('riel apagado: crear aviso → 409 rail_disabled', `${blocked.status} ${blocked.body?.code}`, '409 rail_disabled');
await put(T1, 'monerium-eur', { code: await T1.code(), reason: 'encender Monerium en pruebas', is_enabled: true });
const okIntent = await uA.s.call('POST', '/fiat/payment-intents', { amount: '10' });
check('riel encendido: crear aviso → 201', okIntent.status, 201);
await put(T1, 'monerium-eur', { code: await T1.code(), reason: 'apagar Monerium en pruebas', is_enabled: false });
const withOpen = (await uA.s.call('GET', '/fiat/instructions')).body;
check('apagado con aviso abierto: instrucciones con notice', typeof withOpen.notice, 'string');

// ═════ 6. Visibilidad restringida por cliente
await put(T1, 'monerium-eur', { code: await T1.code(), reason: 'reabrir para prueba de visibilidad', is_enabled: true });
const res = await put(T1, 'monerium-eur', { code: await T1.code(), reason: 'restringir a clientes asignados', visibility: 'restricted' });
check('visibilidad restricted → 200', res.status, 200);
const asg = await T1.call('POST', '/v1/console/fiat/rails/monerium-eur/clients', { code: await T1.code(), reason: 'cliente piloto', client_id: A.id });
check('asignar cliente A → 201', asg.status, 201);
check('asignar de nuevo (par único) no duplica filas', (await db.query(`SELECT count(*)::int AS n FROM fiat_rail_clients WHERE rail_id = 'monerium-eur' AND client_id = $1`, [A.id])).rows[0].n, 1);
const insA = (await uA.s.call('GET', '/fiat/instructions')).body, insB = await uB.s.call('GET', '/fiat/instructions');
check('restricted: el asignado ve el riel', (insA.active_rails ?? []).some((r) => r.rail_id === 'monerium-eur') || !!insA.iban, true);
check('restricted: el no asignado no ve el riel ni el IBAN', `${(insB.body?.active_rails ?? []).some((r) => r.rail_id === 'monerium-eur')} ${!!insB.body?.iban}`, 'false false');
const intA = await uA.s.call('POST', '/fiat/payment-intents', { amount: '11' });
check('restricted: el asignado crea aviso → 201', intA.status, 201);
const intB = await uB.s.call('POST', '/fiat/payment-intents', { amount: '11' });
check('restricted: el no asignado no crea aviso → 409 rail_not_available', `${intB.status} ${intB.body?.code}`, '409 rail_not_available');
const list = await T1.call('GET', `/v1/console/fiat/rails/monerium-eur/clients`);
check('consola: lista de clientes del riel incluye a A', JSON.stringify(list.body).includes(A.id), true);
const mine = await ej.call('GET', `/v1/console/fiat/clients/${A.id}/rails`);
check('detalle del cliente: ejecutivo ve sus rieles asignados', `${mine.status} ${JSON.stringify(mine.body).includes('monerium-eur')}`, '200 true');
check('evento fiat_rail_client_assigned', (await audit('fiat_rail_client_assigned', 'monerium-eur'))?.actor, T1.email);
const un = await T1.call('POST', `/v1/console/fiat/rails/monerium-eur/clients/${A.id}/unassign`, { code: await T1.code(), reason: 'fin del piloto' });
check('quitar asignación → 200', un.status, 200);
check('evento fiat_rail_client_unassigned', (await audit('fiat_rail_client_unassigned', 'monerium-eur'))?.actor, T1.email);
const intA2 = await uA.s.call('POST', '/fiat/payment-intents', { amount: '12' });
check('desasignado: ya no puede crear aviso → 409 rail_not_available', `${intA2.status} ${intA2.body?.code}`, '409 rail_not_available');

// ═════ 6b. Crear, editar y archivar rieles manuales
const NEW = `nuevo-${R}`;
const newBody = { rail_id: NEW, label: `Riel nuevo ${R}`, currency: 'MXN', country: 'MX', rail_type: 'spei', priority: 50, min_amount: '10', max_amount: '5000', reason: 'alta de riel SPEI' };
const post = (t, body) => t.call('POST', '/v1/console/fiat/rails', body);
check('crear riel por ejecutivo → 403', (await post(ej, { ...newBody, code: '000000' })).status, 403);
const keyCreate = await api('POST', '/v1/console/fiat/rails', newBody);
check('crear riel con API_KEY global → 403 forbidden', `${keyCreate.status} ${keyCreate.body?.code}`, '403 forbidden');
check('crear riel sin 2FA → 422 bad_code', (await post(T1, newBody)).body?.code, 'bad_code');
const created = await post(T1, { ...newBody, code: await T1.code() });
check('crear riel manual → 201, nace apagado, manual y sin cuenta', `${created.status} ${created.body?.rail?.is_enabled} ${created.body?.rail?.kind}`, '201 false manual');
check('  …sin cuenta activa en DB', (await db.query('SELECT count(*)::int AS n FROM fiat_rail_accounts WHERE rail_id = $1', [NEW])).rows[0].n, 0);
const dup = await post(T1, { ...newBody, code: await T1.code() });
check('rail_id duplicado → 409 rail_exists', `${dup.status} ${dup.body?.code}`, '409 rail_exists');
check('rail_id inválido → 400', (await post(T1, { ...newBody, rail_id: 'Mal Id!', code: await T1.code() })).status, 400);
const cEv = await audit('fiat_rail_created', NEW);
check('audit_log: fiat_rail_created con after', `${cEv?.actor === T1.email} ${cEv?.m.includes('after')} ${cEv?.m.includes('alta de riel SPEI')}`, 'true true true');
check('encender riel nuevo sin cuenta → 409 rail_without_account', (await put(T1, NEW, { code: await T1.code(), reason: 'encender sin cuenta', is_enabled: true })).body?.code, 'rail_without_account');
check('editar riel por ejecutivo → 403', (await put(ej, NEW, { label: 'x', reason: 'prueba', code: '000000' })).status, 403);
check('editar riel con API_KEY global → 403 forbidden', (await api('PUT', `/v1/console/fiat/rails/${NEW}`, { label: 'x', reason: 'prueba', code: '000000' })).body?.code, 'forbidden');
const upd = await put(T1, NEW, { code: await T1.code(), reason: 'ajuste de metadatos', label: `Riel editado ${R}`, priority: 10, settlement_time: 'mismo día', recommended_for: 'Pagos locales' });
check('editar metadatos de riel manual → 200', `${upd.status} ${upd.body?.rail?.label}`, `200 Riel editado ${R}`);
const uEv = await audit('fiat_rail_updated', NEW);
check('audit_log: fiat_rail_updated con antes/después', `${uEv?.m.includes('before')} ${uEv?.m.includes('Riel editado')} ${uEv?.m.includes('label')}`, 'true true true');
check('editar un seed manual → 200', (await put(T1, 'revolut-eur', { code: await T1.code(), reason: 'editar seed', label: `Revolut EUR ${R}` })).status, 200);
const lockedEdit = await put(T1, 'monerium-eur', { code: await T1.code(), reason: 'intento de edición', label: 'Otro nombre' });
check('riel automático: editar label → 409 rail_locked', `${lockedEdit.status} ${lockedEdit.body?.code}`, '409 rail_locked');
check('riel automático: editar límites → 200', (await put(T1, 'monerium-eur', { code: await T1.code(), reason: 'ajuste de límites', min_amount: '1', max_amount: '100000' })).status, 200);
await put(T1, 'monerium-eur', { code: await T1.code(), reason: 'quitar límites', min_amount: null, max_amount: null });
check('fallback_of a sí mismo → 400', (await put(T1, NEW, { code: await T1.code(), reason: 'ciclo', fallback_of: NEW })).status, 400);
check('archivar riel automático → 409 rail_locked', (await put(T1, 'monerium-eur', { code: await T1.code(), reason: 'archivar auto', is_archived: true })).body?.code, 'rail_locked');
const arch = await put(T1, NEW, { code: await T1.code(), reason: 'riel ya no se usará', is_archived: true });
check('archivar riel manual → 200 (apagado y archivado)', `${arch.status} ${arch.body?.rail?.is_archived} ${arch.body?.rail?.is_enabled}`, '200 true false');
check('  …sin borrado físico', (await db.query('SELECT count(*)::int AS n FROM fiat_rails WHERE rail_id = $1', [NEW])).rows[0].n, 1);
check('  …un riel archivado no se edita (409 rail_archived)', (await put(T1, NEW, { code: await T1.code(), reason: 'editar archivado', label: 'otra' })).body?.code, 'rail_archived');
const rest = await put(T1, NEW, { code: await T1.code(), reason: 'se reactiva el riel', is_archived: false });
check('restaurar riel → 200, vuelve apagado', `${rest.status} ${rest.body?.rail?.is_archived} ${rest.body?.rail?.is_enabled}`, '200 false false');
// quedan avisos EUR abiertos de las secciones 5 y 6
const archOpen = await put(T1, 'revolut-eur', { code: await T1.code(), reason: 'archivo con avisos abiertos', is_archived: true });
check('archivar con avisos abiertos → 409 rail_has_open_intents', `${archOpen.status} ${archOpen.body?.code}`, '409 rail_has_open_intents');

// ═════ 6b. Eliminación definitiva
const del = (t, id, body) => t.call('POST', `/v1/console/fiat/rails/${id}/delete`, body);
const delApi = (id, body) => api('POST', `/v1/console/fiat/rails/${id}/delete`, body);
check('eliminar riel con ejecutivo → 403', (await del(ej, NEW, { reason: 'prueba', confirm: NEW, code: '000000' })).status, 403);
check('eliminar riel con API_KEY global → 403 forbidden', (await delApi(NEW, { reason: 'prueba', confirm: NEW, code: '000000' })).body?.code, 'forbidden');
const delActive = await del(T1, NEW, { code: await T1.code(), reason: 'eliminar sin archivar', confirm: NEW });
check('eliminar riel no archivado → 409 rail_not_archived', `${delActive.status} ${delActive.body?.code}`, '409 rail_not_archived');
await put(T1, NEW, { code: await T1.code(), reason: 'archivar para eliminar', is_archived: true });
check('audit_log: fiat_rail_archived', !!(await audit('fiat_rail_archived', NEW)), true);
check('audit_log: fiat_rail_restored', !!(await audit('fiat_rail_restored', NEW)), true);
check('eliminar con confirmación distinta → 400 confirmation_mismatch', (await del(T1, NEW, { code: await T1.code(), reason: 'confirmación errónea', confirm: 'otro' })).body?.code, 'confirmation_mismatch');
check('eliminar riel automático → 409 rail_locked', (await del(T1, 'monerium-eur', { code: await T1.code(), reason: 'eliminar automático', confirm: 'monerium-eur' })).body?.code, 'rail_locked');
const DEP = `dep-${R}`;
await post(T1, { ...newBody, rail_id: DEP, fallback_of: NEW, code: await T1.code() });
const delHist = await del(T1, NEW, { code: await T1.code(), reason: 'eliminar con dependencia', confirm: NEW });
check('eliminar riel con historial/dependencias → 409 rail_has_history', `${delHist.status} ${delHist.body?.code}`, '409 rail_has_history');
check('  …el riel sigue existiendo', (await db.query('SELECT count(*)::int AS n FROM fiat_rails WHERE rail_id = $1', [NEW])).rows[0].n, 1);
await put(T1, DEP, { code: await T1.code(), reason: 'quitar alterno', fallback_of: null });
const delOk = await del(T1, NEW, { code: await T1.code(), reason: 'riel nunca usado', confirm: NEW });
check('eliminar riel archivado sin historial → 200', `${delOk.status} ${delOk.body?.deleted}`, '200 true');
check('  …borrado de la DB', (await db.query('SELECT count(*)::int AS n FROM fiat_rails WHERE rail_id = $1', [NEW])).rows[0].n, 0);
const dEv = await audit('fiat_rail_deleted', NEW);
check('audit_log: fiat_rail_deleted con rail_id, label y motivo', `${dEv?.m.includes(NEW)} ${dEv?.m.includes('Riel editado')} ${dEv?.m.includes('riel nunca usado')}`, 'true true true');

// ═════ 7. Última alerta de moneda y limpieza
await db.query(`UPDATE fiat_rails SET is_enabled = false WHERE currency = 'USD'`);
await put(T1, 'monerium-eur', { code: await T1.code(), reason: 'volver a visibilidad total', visibility: 'all' });
const lastOff = await put(T1, 'monerium-eur', { code: await T1.code(), reason: 'apagar el último riel EUR', is_enabled: false });
check('apagar el último riel EUR activo → 200', lastOff.status, 200);
check('alerta fiat_rail_last_active_disabled', !!(await audit('fiat_rail_last_active_disabled', 'monerium-eur')), true);

console.log(`\n${ok} ok, ${fail} fallos`);
await db.end();
process.exit(fail ? 1 : 0);
