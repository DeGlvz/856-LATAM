// E2E portal de clientes — fase 1: invitaciones, login, 2FA obligatorio por rol, recuperación, llaves firmadas y AISLAMIENTO.
// Uso: BASE KEY DATABASE_URL BOOT_EMAIL BOOT_PASS node test/portal-fase1.e2e.mjs  (API con COOKIE_SECURE=false y TOTP_ENCRYPTION_KEY)
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import pg from 'pg';
import { totp } from './lib/totp.mjs';

const { BASE, KEY, BOOT_EMAIL, BOOT_PASS, DATABASE_URL } = process.env;
const R = Math.random().toString(36).slice(2, 8);
const NET = `10.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`;
let ok = 0, fail = 0;
const check = (n, got, want) => { if (String(got) === String(want)) { ok++; console.log('✔', n); } else { fail++; console.log(`✘ ${n} — esperado ${want}, obtenido ${got}`); } };
const sha = (s) => createHash('sha256').update(s).digest('hex');

// Navegador del portal (cookie propia + header anti-CSRF) y de la consola
function portal(ip) {
  let cookie = null;
  const call = async (method, path, body, extra = {}) => {
    const r = await fetch(BASE + '/v1/portal' + path, { method, headers: { 'x-forwarded-for': ip, ...(body ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}), ...(method !== 'GET' ? { 'x-856-portal': '1' } : {}), ...extra }, body: body && JSON.stringify(body) });
    const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
    return { status: r.status, body: await r.json().catch(() => null) };
  };
  const login = async (email, password, otp) => {
    const r = await call('POST', '/auth/login', { email, password });
    if (r.body?.mfa_required && otp) return call('POST', '/auth/login/totp', { mfa_token: r.body.mfa_token, code: await otp.next() });
    return r;
  };
  return { call, login, cookie: () => cookie, forget: () => { cookie = null; } };
}
function consoleB(ip) {
  let cookie = null;
  const call = async (method, path, body) => {
    const r = await fetch(BASE + path, { method, headers: { 'x-forwarded-for': ip, ...(body ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}), ...(method !== 'GET' ? { 'x-856-console': '1' } : {}) }, body: body && JSON.stringify(body) });
    const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
    return { status: r.status, body: await r.json().catch(() => null) };
  };
  return { call };
}
const key = async (method, path, body, idem) => {
  const r = await fetch(BASE + path, { method, headers: { 'x-api-key': KEY, 'content-type': 'application/json', ...(idem ? { 'idempotency-key': `${idem}-${R}` } : {}) }, body: body && JSON.stringify(body) });
  return { status: r.status, body: await r.json() };
};
// Petición firmada con Ed25519 (como lo haría el servidor del cliente)
async function signed(priv, prefix, method, path, body, o = {}) {
  const raw = body ? JSON.stringify(body) : '';
  const ts = String(o.ts ?? Math.floor(Date.now() / 1000));
  const nonce = o.nonce ?? Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
  const msg = `${method}\n/v1/portal${path}\n${ts}\n${nonce}\n${sha(raw)}`;
  let sig = sign(null, Buffer.from(msg), priv).toString('base64url');
  if (o.tamper) sig = sig.slice(0, -2) + (sig.endsWith('AA') ? 'BB' : 'AA');
  const r = await fetch(BASE + '/v1/portal' + path, { method, headers: { 'x-forwarded-for': o.ip ?? `${NET}.50`, 'x-856-key': prefix, 'x-856-timestamp': ts, 'x-856-nonce': nonce, 'x-856-signature': sig, ...(body ? { 'content-type': 'application/json' } : {}) }, body: raw || undefined });
  return { status: r.status, body: await r.json().catch(() => null), nonce };
}
const newPair = () => { const { publicKey, privateKey } = generateKeyPairSync('ed25519'); return { priv: privateKey, pub: publicKey.export({ format: 'jwk' }).x }; };
const tokenOf = (link) => link.split('#')[1];

// ═════ Clientes A y B; la operación de 856 invita al primer admin de cada uno
const A = (await key('POST', '/v1/clients', { name: `Portal A ${R}`, assets: ['USDC-ETH-SEPOLIA'] }, 'a')).body;
const B = (await key('POST', '/v1/clients', { name: `Portal B ${R}`, assets: ['USDC-ETH-SEPOLIA'] }, 'b')).body;
for (const c of [A, B]) await key('PATCH', `/v1/clients/${c.id}`, { status: 'active' });
const tes = consoleB(`${NET}.1`); await tes.call('POST', '/v1/auth/login', { email: BOOT_EMAIL, password: BOOT_PASS });
const ADM = `adm-a-${R}@ejemplo.mx`, PW = 'clave-portal-12345';
const invA = await tes.call('POST', `/v1/clients/${A.id}/portal-invite`, { email: ADM });
check('consola invita al primer admin → enlace con token en #', `${invA.status} ${invA.body.link?.startsWith('/portal/invitacion#')}`, '201 true');
const tA = tokenOf(invA.body.link);
const look = await portal(`${NET}.2`).call('POST', '/invites/lookup', { token: tA });
check('consulta de invitación: correo, rol y 2FA requerido', `${look.body.email} ${look.body.role} ${look.body.requires_2fa}`, `${ADM} admin true`);
const pub0 = portal(`${NET}.2`);
check('aceptar con contraseña corta → 400', (await pub0.call('POST', '/invites/accept', { token: tA, name: 'Ana Admin', password: 'corta' })).status, 400);
check('aceptar invitación', (await pub0.call('POST', '/invites/accept', { token: tA, name: 'Ana Admin', password: PW })).body.role, 'admin');
check('  …el enlace no se reutiliza → 404', (await pub0.call('POST', '/invites/accept', { token: tA, name: 'Xavier', password: PW })).status, 404);
check('consola: el cliente ya tiene admin → 409', (await tes.call('POST', `/v1/clients/${A.id}/portal-invite`, { email: `otro-${R}@ejemplo.mx` })).body.code, 'client_has_admin');
check('consola ve el estado del portal del cliente', (await tes.call('GET', `/v1/clients/${A.id}/portal`)).body.admins, 1);

// ═════ Login y 2FA obligatorio para admin
const a = portal(`${NET}.3`);
const l1 = await a.login(ADM, PW);
check('login admin sin 2FA → sesión con alta de 2FA pendiente', `${l1.status} ${l1.body.totp_enrollment_required}`, '200 true');
check('  …sin 2FA no puede administrar usuarios → 403', (await a.call('GET', '/users')).body.code, 'totp_enrollment_required');
check('  …pero sí ve su identidad', (await a.call('GET', '/me')).body.client.id, A.id);
check('sin header del portal → 403 csrf', (await a.call('POST', '/auth/totp/setup', {}, { 'x-856-portal': '' })).body.code, 'csrf');
const st = (await a.call('POST', '/auth/totp/setup', {})).body;
const otpA = totp(st.secret);
const en = (await a.call('POST', '/auth/totp/enable', { code: await otpA.next() })).body;
check('activar 2FA entrega 10 códigos de recuperación', en.recovery_codes?.length, 10);
check('admin no puede desactivar su 2FA → 409', (await a.call('POST', '/auth/totp/disable', { code: await otpA.next() })).body.code, 'totp_required_for_role');
await a.call('POST', '/auth/logout', {}); a.forget();
const l2 = await a.call('POST', '/auth/login', { email: ADM, password: PW });
check('login con 2FA: pide código y no abre sesión', `${l2.body.mfa_required} ${!!a.cookie()}`, 'true false');
check('  …código correcto → sesión', (await a.call('POST', '/auth/login/totp', { mfa_token: l2.body.mfa_token, code: await otpA.next() })).status, 200);
check('  …ya administra usuarios', (await a.call('GET', '/users')).body.users.length, 1);
const ar = portal(`${NET}.4`); const l3 = await ar.call('POST', '/auth/login', { email: ADM, password: PW });
check('entrar con código de recuperación', (await ar.call('POST', '/auth/login/totp', { mfa_token: l3.body.mfa_token, recovery_code: en.recovery_codes[0] })).status, 200);
const l4 = await portal(`${NET}.5`).call('POST', '/auth/login', { email: ADM, password: PW });
check('  …el mismo código no sirve dos veces → 401', (await portal(`${NET}.5`).call('POST', '/auth/login/totp', { mfa_token: l4.body.mfa_token, recovery_code: en.recovery_codes[0] })).status, 401);
check('contraseña incorrecta → 401', (await portal(`${NET}.6`).call('POST', '/auth/login', { email: ADM, password: 'mala-clave-123' })).status, 401);

// ═════ Usuarios del cliente: invitaciones por rol, cambios y Nivel 2 de recuperación
const inv = async (email, r) => (await a.call('POST', '/users/invites', { email, role: r })).body;
const OPE = `ope-a-${R}@ejemplo.mx`, APR = `apr-a-${R}@ejemplo.mx`;
const iO = await inv(OPE, 'operator'); const iP = await inv(APR, 'approver');
check('admin invita operador y aprobador', `${iO.role} ${iP.role}`, 'operator approver');
check('invitaciones pendientes listadas', (await a.call('GET', '/users/invites')).body.invites.length, 2);
await pub0.call('POST', '/invites/accept', { token: tokenOf(iO.link), name: 'Omar Operador', password: PW });
await pub0.call('POST', '/invites/accept', { token: tokenOf(iP.link), name: 'Alma Aprobadora', password: PW });
check('correo ya registrado → 409 email_in_use', (await a.call('POST', '/users/invites', { email: OPE, role: 'viewer' })).body.code, 'email_in_use');
const o = portal(`${NET}.7`); await o.login(OPE, PW);
check('operador entra sin 2FA y no administra usuarios → 403', (await o.call('GET', '/users')).body.code, 'forbidden');
const p = portal(`${NET}.8`); await p.login(APR, PW);
const pst = (await p.call('POST', '/auth/totp/setup', {})).body; const otpP = totp(pst.secret);
await p.call('POST', '/auth/totp/enable', { code: await otpP.next() });
const users = (await a.call('GET', '/users')).body.users;
const idO = users.find((u) => u.email === OPE).id, idP = users.find((u) => u.email === APR).id, idA = users.find((u) => u.email === ADM).id;
check('admin no se cambia a sí mismo → 409', (await a.call('PATCH', `/users/${idA}`, { role: 'viewer' })).body.code, 'self_change');
check('admin baja de rol al operador a viewer', (await a.call('PATCH', `/users/${idO}`, { role: 'viewer' })).body.role, 'viewer');
check('  …su sesión se cierra al instante', (await o.call('GET', '/me')).status, 401);
check('restablecer 2FA del aprobador (Nivel 2, con motivo)', (await a.call('POST', `/users/${idP}/totp/reset`, { reason: 'Perdió el teléfono' })).status, 200);
check('  …sus sesiones quedan cerradas', (await p.call('GET', '/me')).status, 401);
check('  …vuelve a entrar y debe reactivar 2FA', (await portal(`${NET}.9`).login(APR, PW)).body.totp_enrollment_required, true);

// ═════ Llaves de API: Ed25519 con prueba de posesión, firma por petición, anti-replay, IP, bloqueo
const k1 = newPair();
let ch = (await a.call('POST', '/keys/challenge', {})).body;
const proof = (pair, c) => sign(null, Buffer.from(`856-latam/key-proof/v1:${c}`), pair.priv).toString('base64url');
check('alta de llave sin código 2FA → 400', (await a.call('POST', '/keys', { name: 'ERP', kind: 'ed25519', public_key: k1.pub, challenge: ch.challenge, proof: proof(k1, ch.challenge) })).status, 400);
const other = newPair();
check('prueba de posesión de otra llave → 422', (await a.call('POST', '/keys', { name: 'ERP', kind: 'ed25519', public_key: k1.pub, challenge: ch.challenge, proof: proof(other, ch.challenge), code: await otpA.next() })).body.code, 'invalid_proof');
check('  …el reto ya no sirve (un solo uso) → 422', (await a.call('POST', '/keys', { name: 'ERP', kind: 'ed25519', public_key: k1.pub, challenge: ch.challenge, proof: proof(k1, ch.challenge), code: await otpA.next() })).body.code, 'invalid_challenge');
ch = (await a.call('POST', '/keys/challenge', {})).body;
const kA = await a.call('POST', '/keys', { name: 'ERP', kind: 'ed25519', permissions: ['read'], public_key: k1.pub, challenge: ch.challenge, proof: proof(k1, ch.challenge), code: await otpA.next() });
check('alta de llave Ed25519 → 201 (856 solo guarda la pública)', `${kA.status} ${kA.body.prefix?.startsWith('856k_')} ${'public_key' in kA.body}`, '201 true false');
const ping = await signed(k1.priv, kA.body.prefix, 'GET', '/ping');
check('petición firmada → identifica al cliente A', `${ping.status} ${ping.body.client_id === A.id} ${ping.body.via}`, '200 true client_key');
check('misma firma/nonce otra vez → 401 replay', (await signed(k1.priv, kA.body.prefix, 'GET', '/ping', null, { nonce: ping.nonce })).body.code, 'replay');
check('marca de tiempo vieja → 401', (await signed(k1.priv, kA.body.prefix, 'GET', '/ping', null, { ts: Math.floor(Date.now() / 1000) - 900 })).body.code, 'stale_timestamp');
check('firma alterada → 401', (await signed(k1.priv, kA.body.prefix, 'GET', '/ping', null, { tamper: true })).body.code, 'invalid_signature');
check('llave no administra usuarios → 403', (await signed(k1.priv, kA.body.prefix, 'GET', '/users')).body.code, 'session_required');
check('llave no entra a la consola → 401', (await fetch(BASE + '/v1/summary', { headers: { 'x-856-key': kA.body.prefix } })).status, 401);

const k2 = newPair(); ch = (await a.call('POST', '/keys/challenge', {})).body;
const kIp = (await a.call('POST', '/keys', { name: 'Solo oficina', kind: 'ed25519', public_key: k2.pub, challenge: ch.challenge, proof: proof(k2, ch.challenge), ip_allowlist: ['192.0.2.0/24'], code: await otpA.next() })).body;
check('IP fuera de la lista de la llave → 403', (await signed(k2.priv, kIp.prefix, 'GET', '/ping', null, { ip: '198.51.100.7' })).body.code, 'ip_not_allowed');
check('IP dentro del rango → 200', (await signed(k2.priv, kIp.prefix, 'GET', '/ping', null, { ip: '192.0.2.44' })).status, 200);
check('rango inválido → 400', (await a.call('POST', '/keys', { name: 'Rango malo', kind: 'read_token', ip_allowlist: ['999.1.1.1'], code: await otpA.next() })).body.code, 'invalid_ip');

const rt = (await a.call('POST', '/keys', { name: 'BI lectura', kind: 'read_token', code: await otpA.next() })).body;
check('token de lectura: se muestra una vez, solo read', `${/^856r_[0-9a-f]{16}_[A-Za-z0-9_-]{43}_[0-9a-f]{4}$/.test(rt.token)} ${rt.permissions.join()}`, 'true read');
const bearer = (t, method = 'GET', path = '/me') => fetch(BASE + '/v1/portal' + path, { method, headers: { authorization: `Bearer ${t}`, 'x-forwarded-for': `${NET}.60` } }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));
check('token de lectura consulta /me', (await bearer(rt.token)).body.kind, 'key');
check('token con dígito verificador erróneo → 401', (await bearer(rt.token.slice(0, -1) + (rt.token.endsWith('0') ? '1' : '0'))).status, 401);
check('token no puede escribir → 403', (await bearer(rt.token, 'POST', '/auth/logout')).body.code, 'session_required');
const { rows: [stored] } = await (async () => { const db = new pg.Client({ connectionString: DATABASE_URL }); await db.connect(); const r = await db.query('SELECT token_hash, public_key FROM client_api_keys WHERE prefix = $1', [rt.prefix]); await db.end(); return r; })();
check('en la base solo queda el hash del token', `${stored.token_hash === sha(rt.token)} ${!JSON.stringify(stored).includes(rt.token)}`, 'true true');

const rot = (await a.call('POST', `/keys/${rt.id}/rotate`, { code: await otpA.next() })).body;
check('rotación sin corte: llave nueva y la anterior sigue vigente', `${(await bearer(rot.token)).status} ${(await bearer(rt.token)).status}`, '200 200');
check('  …la anterior vence en el traslape', new Date(rot.previous_expires_at) < new Date(Date.now() + 8 * 86400000), true);
check('revocar → deja de funcionar al instante', `${(await a.call('POST', `/keys/${rt.id}/revoke`, {})).status} ${(await bearer(rt.token)).status}`, '200 401');
for (let i = 0; i < 10; i++) await signed(k1.priv, kA.body.prefix, 'GET', '/ping', null, { tamper: true });
check('10 firmas inválidas → llave bloqueada (423)', (await signed(k1.priv, kA.body.prefix, 'GET', '/ping')).status, 423);

// ═════ AISLAMIENTO: el admin de B no ve ni toca nada de A (404, no 403)
const ADMB = `adm-b-${R}@ejemplo.mx`;
await pub0.call('POST', '/invites/accept', { token: tokenOf((await tes.call('POST', `/v1/clients/${B.id}/portal-invite`, { email: ADMB })).body.link), name: 'Beto Admin', password: PW });
const b = portal(`${NET}.10`); await b.login(ADMB, PW);
const bst = (await b.call('POST', '/auth/totp/setup', {})).body; const otpB = totp(bst.secret);
await b.call('POST', '/auth/totp/enable', { code: await otpB.next() });
check('B ve solo sus usuarios', (await b.call('GET', '/users')).body.users.map((u) => u.email).join(), ADMB);
check('B ve solo sus llaves', (await b.call('GET', '/keys')).body.keys.length, 0);
check('B no cambia un usuario de A → 404', (await b.call('PATCH', `/users/${idO}`, { active: false })).status, 404);
check('B no restablece 2FA de A → 404', (await b.call('POST', `/users/${idA}/totp/reset`, { reason: 'intento cruzado' })).status, 404);
check('B no revoca llaves de A → 404', (await b.call('POST', `/keys/${kIp.id}/revoke`, {})).status, 404);
check('B no rota llaves de A → 404', (await b.call('POST', `/keys/${kIp.id}/rotate`, { code: await otpB.next() })).status, 404);
const pendA = (await a.call('POST', '/users/invites', { email: `pend-${R}@ejemplo.mx`, role: 'viewer' })).body;
check('B no revoca invitaciones de A → 404', (await b.call('POST', `/users/invites/${pendA.id}/revoke`, {})).status, 404);
check('B no elimina un usuario de A → 404', (await b.call('DELETE', `/users/${idO}`, { confirm: true })).status, 404);
check('la llave de A sigue intacta', (await signed(k2.priv, kIp.prefix, 'GET', '/ping', null, { ip: '192.0.2.44' })).body.client_id, A.id);
check('la sesión del portal no abre la consola → 401', (await b.call('GET', '/../summary')).status === 401 || (await fetch(BASE + '/v1/summary', { headers: { cookie: `c856p=x` } })).status === 401, true);

// ═════ Eliminación de usuario: bloquea cualquier operación financiera abierta y conserva historial
const deletionDb = new pg.Client({ connectionString: DATABASE_URL }); await deletionDb.connect();
const assetId = 'USDC-ETH-SEPOLIA';
const { rows: [account] } = await deletionDb.query('SELECT id FROM accounts WHERE client_id = $1 AND asset_id = $2 LIMIT 1', [A.id, assetId]);
if (!account) throw new Error('No hay cuenta de prueba para el cliente A');
const openObligations = await deletionDb.query(
  `INSERT INTO obligations (debtor_id, creditor_id, asset_id, amount, status, origin_kind, origin_ref, created_by)
   SELECT $1,$2,$3,1,status,'client_user',$4,$5 FROM unnest(ARRAY['open','pending_acceptance']) AS statuses(status) RETURNING id`,
  [B.id, A.id, assetId, idO, `portal:${OPE}`]);
const openIntent = await deletionDb.query(
  `INSERT INTO fiat_payment_intents (client_id, reference, expected_amount, expires_at, status, origin_kind, origin_ref, created_by)
   VALUES ($1,$2,1,now() + interval '1 day','open','client_user',$3,$4) RETURNING id`,
  [A.id, `856-${R.toUpperCase().padEnd(4, 'A').slice(0, 4)}-${R.toUpperCase().padEnd(4, 'B').slice(0, 4)}-001`, idO, `portal:${OPE}`]);
const openWithdrawals = await deletionDb.query(
  `INSERT INTO withdrawals (client_id, account_id, asset_id, to_address, amount, status, origin_kind, origin_ref, network)
   SELECT $1,$2,$3,$4,1,status,'client_user',$5,'eth-sepolia'
     FROM unnest(ARRAY['reserved','signed','broadcast']) AS statuses(status) RETURNING id`,
  [A.id, account.id, assetId, `0x${'a'.repeat(40)}`, idO]);
const keyPrefix = `856r_${Math.random().toString(16).slice(2, 18).padEnd(16, '0')}`;
await deletionDb.query(
  `INSERT INTO client_api_keys (client_id, name, kind, prefix, token_hash, permissions, expires_at, created_by)
   VALUES ($1,'Usuario de prueba','read_token',$2,$3,ARRAY['read'],now() + interval '1 day',$4)`,
  [A.id, keyPrefix, sha(`secret-${R}`), idO]);
await deletionDb.end();
const blockedDelete = await a.call('DELETE', `/users/${idO}`, { confirm: true });
check('eliminación se bloquea con todas las categorías abiertas atribuibles', `${blockedDelete.status} ${blockedDelete.body.code} ${blockedDelete.body.error.includes('obligaciones: 2') && blockedDelete.body.error.includes('retiros: 3') && blockedDelete.body.error.includes('avisos fiat: 1')}`,
  '409 user_has_open_financial_operations true');
const resolveDb = new pg.Client({ connectionString: DATABASE_URL }); await resolveDb.connect();
await resolveDb.query('UPDATE obligations SET status = $2 WHERE id = ANY($1::uuid[])', [openObligations.rows.map((o) => o.id), 'cancelled']);
await resolveDb.query('UPDATE fiat_payment_intents SET status = $2 WHERE id = $1', [openIntent.rows[0].id, 'cancelled']);
await resolveDb.query('UPDATE withdrawals SET status = $2 WHERE id = ANY($1::uuid[])', [openWithdrawals.rows.map((w) => w.id), 'failed']);
await resolveDb.end();
const deleted = await a.call('DELETE', `/users/${idO}`, { confirm: true });
check('eliminación de usuario sin operaciones abiertas', `${deleted.status} ${deleted.body.deleted}`, '200 true');
check('la identidad ya no aparece en usuarios', (await a.call('GET', '/users')).body.users.some((u) => u.id === idO), false);
const deletedActorKey = (await a.call('GET', '/keys')).body.keys.find((k) => k.prefix === keyPrefix);
check('se revoca y conserva la atribución de llaves creadas por el usuario', `${deletedActorKey?.created_by} ${!!deletedActorKey?.revoked_at}`, `${OPE} true`);
const historyDb = new pg.Client({ connectionString: DATABASE_URL }); await historyDb.connect();
const { rows: [history] } = await historyDb.query(
  `SELECT o.origin_user_name, o.origin_user_email, w.origin_user_name AS withdrawal_name, w.origin_user_email AS withdrawal_email
     FROM obligations o CROSS JOIN withdrawals w WHERE o.id = $1 AND w.id = $2`,
  [openObligations.rows[0].id, openWithdrawals.rows[0].id]);
await historyDb.end();
check('se conserva la atribución histórica después del borrado', `${history.origin_user_name} ${history.origin_user_email} ${history.withdrawal_name} ${history.withdrawal_email}`,
  `Omar Operador ${OPE} Omar Operador ${OPE}`);

// ═════ Bitácora con cliente
const db = new pg.Client({ connectionString: DATABASE_URL }); await db.connect();
const { rows } = await db.query(`SELECT action, actor FROM audit_log WHERE client_id = $1 ORDER BY id`, [A.id]);
await db.end();
check('bitácora: alta de llave con cliente A', rows.some((r) => r.action === 'PORTAL POST /v1/portal/keys' && r.actor === `portal:${ADM}`), true);
check('bitácora: login con código de recuperación', rows.some((r) => r.action === 'portal_login'), true);
check('bitácora conserva al actor de eliminación', rows.some((r) => r.action === 'PORTAL DELETE /v1/portal/users/:id' && r.actor === `portal:${ADM}` && r.status === 200), true);
check('bitácora: nada de B mezclado en A', rows.every((r) => !r.actor.includes(ADMB)), true);

console.log(`\n${ok} ok, ${fail} fallos`);
process.exit(fail ? 1 : 0);
