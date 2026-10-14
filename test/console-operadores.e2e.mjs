// E2E consola — administración de operadores: invitaciones, rol, estado, step-up 2FA, último tesorero, alertas del portal y bitácora.
// Uso: BASE KEY DATABASE_URL BOOT_EMAIL BOOT_PASS node test/console-operadores.e2e.mjs
// API con COOKIE_SECURE=false y TOTP_ENCRYPTION_KEY. El tesorero inicial (BOOT) debe entrar sin 2FA: la prueba se lo activa
// y al final se lo desactiva para no afectar a las demás pruebas.
import { execFileSync } from 'node:child_process';
import pg from 'pg';
import { totp } from './lib/totp.mjs';

const { BASE, KEY, BOOT_EMAIL, BOOT_PASS, DATABASE_URL } = process.env;
const db = new pg.Client({ connectionString: DATABASE_URL }); await db.connect();
const R = Math.random().toString(36).slice(2, 8);
const NET = `10.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`;
let ok = 0, fail = 0, ipN = 1;
const check = (n, got, want) => { if (String(got) === String(want)) { ok++; console.log('✔', n); } else { fail++; console.log(`✘ ${n} — esperado ${want}, obtenido ${got}`); } };

function browser(ip = `${NET}.${ipN++}`) {
  let cookie = null;
  const call = async (method, path, body) => {
    const r = await fetch(BASE + path, { method, headers: { 'x-forwarded-for': ip, ...(body ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}), ...(method !== 'GET' ? { 'x-856-console': '1' } : {}) }, body: body && JSON.stringify(body) });
    const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
    return { status: r.status, body: await r.json().catch(() => null) };
  };
  const login = async (email, password, otp) => {
    cookie = null;
    const r = await call('POST', '/v1/auth/login', { email, password });
    if (r.body?.mfa_required && otp) return call('POST', '/v1/auth/login/totp', { mfa_token: r.body.mfa_token, code: await otp.next() });
    return r;
  };
  return { call, login };
}
const key = async (method, path, body, idem) => {
  const r = await fetch(BASE + path, { method, headers: { 'x-api-key': KEY, 'content-type': 'application/json', ...(idem ? { 'idempotency-key': `${idem}-${R}` } : {}) }, body: body && JSON.stringify(body) });
  return { status: r.status, body: await r.json().catch(() => null) };
};
const createOperator = (email, role, pw) => execFileSync('node', ['dist/scripts/create-operator.js', email, role], { input: pw + '\n', env: process.env, stdio: ['pipe', 'pipe', 'ignore'] });
const tokenOf = (link) => link.split('#')[1];
const pub = () => browser(); // visitante sin sesión (IP nueva: el límite por IP no interfiere)
const opsList = async (b) => (await b.call('GET', '/v1/operators')).body.operators;

// ═════ Tesorero inicial: sin 2FA no administra; con 2FA sí ═════
const t1 = browser();
const lg0 = await t1.login(BOOT_EMAIL, BOOT_PASS);
check('login tesorero inicial (sin 2FA)', `${lg0.status} ${!!lg0.body?.mfa_required}`, '200 false');
if (lg0.body?.mfa_required) { console.log('El tesorero inicial ya tiene 2FA: reinicie la base de pruebas'); process.exit(1); }
const NEW1 = `nuevo-${R}@ejemplo.mx`, PW1 = 'clave-invitado-1234';
check('actor sin 2FA → 403 totp_required', (await t1.call('POST', '/v1/operators/invites', { email: NEW1, role: 'ejecutivo', code: '123456' })).body?.code, 'totp_required');
const s1 = (await t1.call('POST', '/v1/auth/totp/setup', {})).body;
const otp1 = totp(s1.secret);
check('tesorero inicial activa su 2FA', (await t1.call('POST', '/v1/auth/totp/enable', { code: await otp1.next() })).body.totp_enabled, true);
check('API key no administra operadores → 403', (await key('POST', '/v1/operators/invites', { email: NEW1, role: 'ejecutivo', code: '123456' })).body?.code, 'operator_only');

// ═════ Invitar ═════
check('invitar sin code → 400', (await t1.call('POST', '/v1/operators/invites', { email: NEW1, role: 'ejecutivo' })).status, 400);
check('invitar con rol inválido → 400', (await t1.call('POST', '/v1/operators/invites', { email: NEW1, role: 'admin', code: '123456' })).status, 400);
check('invitar con code incorrecto → 422', (await t1.call('POST', '/v1/operators/invites', { email: NEW1, role: 'ejecutivo', code: otp1.wrong() })).body?.code, 'bad_code');
const inv1 = await t1.call('POST', '/v1/operators/invites', { email: NEW1.toUpperCase(), role: 'ejecutivo', code: await otp1.next() });
check('invitar con code → 201 y enlace con token en #', `${inv1.status} ${inv1.body.link?.startsWith('/console/invitacion#')} ${inv1.body.email} ${inv1.body.role}`, `201 true ${NEW1} ejecutivo`);
const ttlH = Math.round((new Date(inv1.body.expires_at) - Date.now()) / 3600_000);
check('  …vigencia por defecto 72 h', ttlH, 72);
const tok1 = tokenOf(inv1.body.link);
check('  …solo el hash queda en la base', (await db.query('SELECT count(*)::int AS n FROM operator_invites WHERE token_hash = $1', [tok1])).rows[0].n, 0);
check('invitación vigente para el mismo correo → 409', (await t1.call('POST', '/v1/operators/invites', { email: NEW1, role: 'lectura', code: await otp1.next() })).body?.code, 'invite_pending');
const pend = (await t1.call('GET', '/v1/operators/invites')).body.invites;
check('lista de invitaciones pendientes', pend.some((i) => i.id === inv1.body.id && i.created_by === BOOT_EMAIL.toLowerCase() && !('token_hash' in i)), true);

// ═════ Consultar y aceptar (público) ═════
const p1 = pub();
const lk = await p1.call('POST', '/v1/auth/invites/lookup', { token: tok1 });
check('lookup: correo, rol y vencimiento', `${lk.status} ${lk.body.email} ${lk.body.role} ${!!lk.body.expires_at}`, `200 ${NEW1} ejecutivo true`);
check('lookup con token falso → 404', (await p1.call('POST', '/v1/auth/invites/lookup', { token: 'x'.repeat(43) })).body?.code, 'invalid_invite');
check('aceptar con contraseña corta → 400', (await p1.call('POST', '/v1/auth/invites/accept', { token: tok1, name: 'Nuevo Operador', password: 'corta' })).body?.code, 'weak_password');
const acc = await p1.call('POST', '/v1/auth/invites/accept', { token: tok1, name: 'Nuevo Operador', password: PW1 });
check('aceptar → 201 operador creado', `${acc.status} ${acc.body.email} ${acc.body.role}`, `201 ${NEW1} ejecutivo`);
check('  …el enlace no se reutiliza → 404', (await p1.call('POST', '/v1/auth/invites/accept', { token: tok1, name: 'Otro', password: PW1 })).status, 404);
check('  …lookup de enlace usado → 404', (await p1.call('POST', '/v1/auth/invites/lookup', { token: tok1 })).status, 404);
check('  …ya no aparece como pendiente', (await t1.call('GET', '/v1/operators/invites')).body.invites.some((i) => i.id === inv1.body.id), false);

const n1 = browser();
check('login del invitado', (await n1.login(NEW1, PW1)).body.operator?.role, 'ejecutivo');
check('operador no ve la lista de operadores → 403', (await n1.call('GET', '/v1/operators')).status, 403);
check('operador no invita → 403', (await n1.call('POST', '/v1/operators/invites', { email: `x-${R}@ejemplo.mx`, role: 'lectura', code: '123456' })).status, 403);
let row = (await opsList(t1)).find((o) => o.email === NEW1);
check('GET /operators: active, totp, sesiones, fechas', `${row.active} ${row.totp_enabled} ${row.active_sessions} ${!!row.last_login_at} ${!!row.created_at}`, 'true false 1 true true');
const id1 = row.id;
check('invitar a un operador activo → 409 email_in_use', (await t1.call('POST', '/v1/operators/invites', { email: NEW1, role: 'lectura', code: await otp1.next() })).body?.code, 'email_in_use');

// ═════ Cambiar rol: revoca sesiones ═════
const pr = await t1.call('PATCH', `/v1/operators/${id1}`, { role: 'tesorero', code: await otp1.next() });
check('cambiar rol a tesorero', `${pr.status} ${pr.body.operator?.role} ${pr.body.sessions_revoked}`, '200 tesorero 1');
check('  …la sesión del invitado queda revocada → 401', (await n1.call('GET', '/v1/auth/me')).status, 401);
check('PATCH sin cambios indicados → 400', (await t1.call('PATCH', `/v1/operators/${id1}`, { code: '123456' })).status, 400);
check('PATCH de operador inexistente → 404', (await t1.call('PATCH', '/v1/operators/00000000-0000-4000-8000-000000000000', { active: false, code: await otp1.next() })).status, 404);

// El invitado (ya tesorero) sin 2FA no puede administrar
await n1.login(NEW1, PW1);
check('tesorero sin 2FA → 403 totp_required', (await n1.call('PATCH', `/v1/operators/${id1}`, { active: false, code: '123456' })).body?.code, 'totp_required');
const s2 = (await n1.call('POST', '/v1/auth/totp/setup', {})).body;
const otp2 = totp(s2.secret);
check('invitado activa su 2FA', (await n1.call('POST', '/v1/auth/totp/enable', { code: await otp2.next() })).body.totp_enabled, true);

// ═════ Desactivar / reactivar ═════
const de = await t1.call('PATCH', `/v1/operators/${id1}`, { active: false, code: await otp1.next() });
check('desactivar', `${de.status} ${de.body.operator?.active} ${de.body.sessions_revoked}`, '200 false 1');
check('  …su sesión cae → 401', (await n1.call('GET', '/v1/auth/me')).status, 401);
check('  …no puede entrar → 401', (await browser().login(NEW1, PW1)).status, 401);
row = (await opsList(t1)).find((o) => o.id === id1);
check('  …lista: inactivo, quién y cuándo, 0 sesiones', `${row.active} ${row.deactivated_by} ${!!row.deactivated_at} ${row.active_sessions}`, `false ${BOOT_EMAIL.toLowerCase()} true 0`);
check('invitar el correo de un desactivado → 409 operator_inactive', (await t1.call('POST', '/v1/operators/invites', { email: NEW1, role: 'lectura', code: await otp1.next() })).body?.code, 'operator_inactive');
const re = await t1.call('PATCH', `/v1/operators/${id1}`, { active: true, code: await otp1.next() });
check('reactivar', `${re.status} ${re.body.operator?.active} ${re.body.operator?.deactivated_at}`, '200 true null');
check('  …no restaura sesiones → 401', (await n1.call('GET', '/v1/auth/me')).status, 401);
check('  …vuelve a entrar (con 2FA)', (await n1.login(NEW1, PW1, otp2)).body.operator?.role, 'tesorero');

// ═════ Reglas de seguridad ═════
const me1 = (await opsList(t1)).find((o) => o.email === BOOT_EMAIL.toLowerCase());
check('modificarse a sí mismo → 403 self_change', (await t1.call('PATCH', `/v1/operators/${me1.id}`, { role: 'lectura', code: '123456' })).body?.code, 'self_change');

// Último tesorero: dejamos solo a t1 y al invitado como tesoreros activos con 2FA y se degradan mutuamente en paralelo
const others = (await db.query(
  `UPDATE operators SET active = false WHERE role = 'tesorero' AND active AND totp_enabled_at IS NOT NULL AND id <> ALL($1::uuid[]) RETURNING id`,
  [[me1.id, id1]])).rows.map((r) => r.id);
const [c1, c2] = [await otp1.next(), await otp2.next()];
const race = await Promise.all([
  t1.call('PATCH', `/v1/operators/${id1}`, { role: 'ejecutivo', code: c1 }),
  n1.call('PATCH', `/v1/operators/${me1.id}`, { role: 'ejecutivo', code: c2 }),
]);
check('degradación cruzada simultánea: una pasa y la otra → 409 last_treasurer',
  race.map((r) => r.status).sort().join(' ') + ' ' + race.find((r) => r.status === 409)?.body?.code, '200 409 last_treasurer');
// Restaurar: el que quedó como tesorero vuelve a subir al otro
const t1Won = race[0].status === 200;
const [winner, wOtp, loser, lOtp, loserId, loserEmail, loserPw] = t1Won
  ? [t1, otp1, n1, otp2, id1, NEW1, PW1] : [n1, otp2, t1, otp1, me1.id, BOOT_EMAIL, BOOT_PASS];
check('  …el perdedor fue degradado y su sesión revocada', (await loser.call('GET', '/v1/auth/me')).status, 401);
check('  …se restaura su rol', (await winner.call('PATCH', `/v1/operators/${loserId}`, { role: 'tesorero', code: await wOtp.next() })).body.operator?.role, 'tesorero');
await loser.login(loserEmail, loserPw, lOtp);
if (others.length) await db.query('UPDATE operators SET active = true WHERE id = ANY($1::uuid[])', [others]);

// ═════ Revocar, usada, vencida ═════
const NEW2 = `rev-${R}@ejemplo.mx`, NEW3 = `venc-${R}@ejemplo.mx`;
const inv2 = (await n1.call('POST', '/v1/operators/invites', { email: NEW2, role: 'lectura', code: await otp2.next() })).body;
check('revocar sin code → 400', (await t1.call('POST', `/v1/operators/invites/${inv2.id}/revoke`, {})).status, 400);
const rv = await t1.call('POST', `/v1/operators/invites/${inv2.id}/revoke`, { code: await otp1.next() });
check('revocar invitación', `${rv.status} ${rv.body.revoked}`, '200 true');
check('  …revocar otra vez → 409', (await n1.call('POST', `/v1/operators/invites/${inv2.id}/revoke`, { code: await otp2.next() })).body?.code, 'invite_not_pending');
const p2 = pub();
check('  …token revocado no sirve (lookup) → 404', (await p2.call('POST', '/v1/auth/invites/lookup', { token: tokenOf(inv2.link) })).status, 404);
check('  …token revocado no sirve (accept) → 404', (await p2.call('POST', '/v1/auth/invites/accept', { token: tokenOf(inv2.link), name: 'Revocado', password: PW1 })).status, 404);
check('  …tras revocar se puede reinvitar', (await t1.call('POST', '/v1/operators/invites', { email: NEW2, role: 'lectura', code: await otp1.next() })).status, 201);
const inv3 = (await n1.call('POST', '/v1/operators/invites', { email: NEW3, role: 'lectura', code: await otp2.next() })).body;
await db.query(`UPDATE operator_invites SET expires_at = now() - interval '1 minute' WHERE id = $1`, [inv3.id]);
check('token vencido no sirve (lookup) → 404', (await p2.call('POST', '/v1/auth/invites/lookup', { token: tokenOf(inv3.link) })).status, 404);
check('token vencido no sirve (accept) → 404', (await p2.call('POST', '/v1/auth/invites/accept', { token: tokenOf(inv3.link), name: 'Vencido', password: PW1 })).status, 404);
check('  …ni sale en pendientes', (await t1.call('GET', '/v1/operators/invites')).body.invites.some((i) => i.id === inv3.id), false);

// ═════ Lectura y operador no administran ═════
const LEC = `lec-${R}@ejemplo.mx`, OPR = `opr-${R}@ejemplo.mx`;
createOperator(LEC, 'lectura', 'clave-lectura-123'); createOperator(OPR, 'ejecutivo', 'clave-operador-123');
const lec = browser(); await lec.login(LEC, 'clave-lectura-123');
const opr = browser(); await opr.login(OPR, 'clave-operador-123');
check('lectura: GET /operators/invites → 403', (await lec.call('GET', '/v1/operators/invites')).status, 403);
check('lectura: POST invites → 403', (await lec.call('POST', '/v1/operators/invites', { email: `z-${R}@ejemplo.mx`, role: 'lectura', code: '123456' })).status, 403);
check('operador: PATCH /operators/:id → 403', (await opr.call('PATCH', `/v1/operators/${id1}`, { active: false, code: '123456' })).status, 403);
check('operador: revocar → 403', (await opr.call('POST', `/v1/operators/invites/${inv3.id}/revoke`, { code: '123456' })).status, 403);

// ═════ Alertas del portal (lectura+) ═════
const cl = (await key('POST', '/v1/clients', { name: `Alertas ${R}`, assets: ['USDC-ETH-SEPOLIA'] }, 'cl')).body;
await key('PATCH', `/v1/clients/${cl.id}`, { status: 'active' });
check('cliente sin usuarios de portal no alerta', (await lec.call('GET', '/v1/clients/portal-alerts')).body.clients.some((c) => c.client_id === cl.id), false);
const pi = await t1.call('POST', `/v1/clients/${cl.id}/portal-invite`, { email: `adm-${R}@ejemplo.mx` });
const pa = await fetch(`${BASE}/v1/portal/invites/accept`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': `${NET}.240` }, body: JSON.stringify({ token: tokenOf(pi.body.link), name: 'Admin Único', password: 'clave-portal-12345' }) });
check('primer admin del portal aceptado', pa.status < 300, true);
const al = await lec.call('GET', '/v1/clients/portal-alerts');
const mine = al.body.clients.find((c) => c.client_id === cl.id);
check('lectura ve alertas: cliente con 1 admin', `${al.status} ${mine?.name} ${mine?.admins} ${mine?.users}`, `200 Alertas ${R} 1 1`);
check('  …GET /clients/:id sigue resolviendo', (await lec.call('GET', `/v1/clients/${cl.id}`)).body.id, cl.id);

// ═════ Bitácora ═════
const acts = async (action, target) => (await t1.call('GET', `/v1/audit?action=${action}${target ? `&target=${encodeURIComponent(target)}` : ''}&limit=50`)).body.entries;
const created = await acts('operator_invite_created', NEW1);
check('bitácora: invitación creada (sin token ni enlace)', `${created.length >= 1} ${JSON.stringify(created).includes(tok1)} ${JSON.stringify(created).includes('invitacion#')}`, 'true false false');
check('bitácora: invitación aceptada', (await acts('operator_invite_accepted', NEW1)).length, 1);
check('bitácora: cambio de rol', (await acts('operator_role_changed', NEW1)).some((e) => e.metadata.from === 'ejecutivo' && e.metadata.to === 'tesorero'), true);
check('bitácora: desactivación y reactivación', `${(await acts('operator_deactivated', NEW1)).length} ${(await acts('operator_reactivated', NEW1)).length}`, '1 1');
check('bitácora: revocación', (await acts('operator_invite_revoked', NEW2)).length, 1);
const all = JSON.stringify(await acts('operator_role_changed'));
check('bitácora sin secretos (contraseña ni códigos)', `${all.includes(PW1)} ${/"code"/.test(all)}`, 'false false');

// ═════ Último tesorero con 2FA no puede apagar su propio 2FA ═════
const solo = (await db.query(
  `UPDATE operators SET active = false WHERE role = 'tesorero' AND active AND totp_enabled_at IS NOT NULL AND id <> $1 RETURNING id`,
  [me1.id])).rows.map((r) => r.id);
const lastCode = await otp1.next();
const ld = await t1.call('POST', '/v1/auth/totp/disable', { code: lastCode });
check('último tesorero activo con 2FA no apaga su 2FA → 409 last_treasurer', `${ld.status} ${ld.body?.code}`, '409 last_treasurer');
check('  …el 2FA sigue activo', (await t1.call('GET', '/v1/auth/me')).body.operator.totp_enabled, true);
if (solo.length) await db.query('UPDATE operators SET active = true WHERE id = ANY($1::uuid[])', [solo]);
check('operador (no tesorero) sí puede apagar su 2FA', await (async () => {
  const OPT = `opt-${R}@ejemplo.mx`; createOperator(OPT, 'ejecutivo', 'clave-operador-123');
  const b = browser(); await b.login(OPT, 'clave-operador-123');
  const o = totp((await b.call('POST', '/v1/auth/totp/setup', {})).body.secret);
  await b.call('POST', '/v1/auth/totp/enable', { code: await o.next() });
  return (await b.call('POST', '/v1/auth/totp/disable', { code: await o.next() })).body?.totp_enabled;
})(), false);

// ═════ Limpieza: el tesorero inicial vuelve a entrar sin 2FA (las otras pruebas lo usan así) ═════
// Con otro tesorero con 2FA activo ya puede; el código rechazado arriba no se gastó (se valida antes de consumirlo)
check('limpieza: desactivar 2FA del tesorero inicial (mismo código)', (await t1.call('POST', '/v1/auth/totp/disable', { code: lastCode })).body?.totp_enabled, false);

await db.end();
console.log(`\n${ok} ok, ${fail} fallos`);
process.exit(fail ? 1 : 0);
