// E2E portal de clientes — fase 3: lista blanca, simulación, salida originada por el cliente y autorizada por tesorería de 856.
// Uso: BASE KEY DATABASE_URL RPC_URL node test/portal-fase3.e2e.mjs
//      API con ORIGIN_RULE=enforce, COOKIE_SECURE=false, TOTP_ENCRYPTION_KEY, SIGNER_PRIVATE_KEY, CONFIRMATIONS=1; cadena local.
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import pg from 'pg';
import { createPublicClient, http } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { hardhat } from 'viem/chains';
import { totp } from './lib/totp.mjs';
import { makeApprover } from './lib/approver.mjs';

const { BASE, KEY, DATABASE_URL, RPC_URL } = process.env;
const R = Math.random().toString(36).slice(2, 8);
const NET = `10.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`;
let ok = 0, fail = 0;
const check = (n, got, want) => { if (String(got) === String(want)) { ok++; console.log('✔', n); } else { fail++; console.log(`✘ ${n} — esperado ${want}, obtenido ${got}`); } };
const sha = (s) => createHash('sha256').update(s).digest('hex');
const db = new pg.Pool({ connectionString: DATABASE_URL });
const chain = createPublicClient({ chain: hardhat, transport: http(RPC_URL) });
const mine = async (n) => { for (let i = 0; i < n; i++) await chain.request({ method: 'evm_mine', params: [] }); };
const ETH = 'ETH-SEPOLIA';
const E = (n) => (BigInt(Math.round(n * 1e6)) * 10n ** 12n).toString(); // ETH → wei (exacto a 6 decimales)
const PW = 'clave-portal-12345';

function session(ip, prefix) {
  let cookie = null;
  const call = async (method, path, body) => {
    const r = await fetch(BASE + prefix + path, { method, headers: { 'x-forwarded-for': ip, ...(body ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}), ...(method !== 'GET' ? { [prefix === '/v1/portal' ? 'x-856-portal' : 'x-856-console']: '1' } : {}) }, body: body && JSON.stringify(body) });
    const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
    return { status: r.status, body: await r.json().catch(() => null) };
  };
  return { call };
}
const api = async (method, path, body, idem) => {
  const r = await fetch(BASE + path, { method, headers: { 'x-api-key': KEY, 'content-type': 'application/json', ...(idem ? { 'idempotency-key': `${idem}-${R}` } : {}) }, body: body && JSON.stringify(body) });
  return { status: r.status, body: await r.json().catch(() => null) };
};
async function signed(priv, prefix, method, path, body) {
  const raw = body ? JSON.stringify(body) : '';
  const ts = String(Math.floor(Date.now() / 1000)), nonce = Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
  const sig = sign(null, Buffer.from(`${method}\n/v1/portal${path}\n${ts}\n${nonce}\n${sha(raw)}`), priv).toString('base64url');
  const r = await fetch(BASE + '/v1/portal' + path, { method, headers: { 'x-forwarded-for': `${NET}.50`, 'x-856-key': prefix, 'x-856-timestamp': ts, 'x-856-nonce': nonce, 'x-856-signature': sig, ...(body ? { 'content-type': 'application/json' } : {}) }, body: raw || undefined });
  return { status: r.status, body: await r.json().catch(() => null) };
}
const createOperator = (email, role) => execFileSync('node', ['dist/scripts/create-operator.js', email, role], { input: 'clave-ejecutivo-123\n', env: process.env, stdio: ['pipe', 'pipe', 'ignore'] });
const tick = () => api('POST', '/v1/worker/tick');

// ═════ Preparación
const A = (await api('POST', '/v1/clients', { name: `Salidas Alfa ${R}`, assets: [ETH] }, 'a')).body;
const B = (await api('POST', '/v1/clients', { name: `Salidas Beta ${R}`, assets: [ETH] }, 'b')).body;
await api('PATCH', `/v1/clients/${A.id}`, { status: 'active' });
await api('PATCH', `/v1/clients/${B.id}`, { status: 'active' });
await api('POST', '/v1/entries', { kind: 'deposit', postings: [
  { account: `client:${A.id}:${ETH}:available`, direction: 'credit', amount: E(1) },
  { account: `system:${ETH}:custody`, direction: 'debit', amount: E(1) }] }, 'fund');

async function enroll(clientId, n, role, inviter) {
  const email = `p3-${role}-${n}-${R}@ejemplo.mx`;
  const inv = inviter ? (await inviter.s.call('POST', '/users/invites', { email, role })).body : (await api('POST', `/v1/clients/${clientId}/portal-invite`, { email })).body;
  const s = session(`${NET}.${n}`, '/v1/portal');
  await s.call('POST', '/invites/accept', { token: inv.link.split('#')[1], name: `Usuario ${role} ${n}`, password: PW });
  await s.call('POST', '/auth/login', { email, password: PW });
  let otp = null;
  if (role === 'admin' || role === 'approver') {
    const st = (await s.call('POST', '/auth/totp/setup', {})).body; otp = totp(st.secret);
    await s.call('POST', '/auth/totp/enable', { code: await otp.next() });
  }
  return { s, otp, email, id: (await s.call('GET', '/me')).body.user.id };
}
const adm = await enroll(A.id, 2, 'admin');
const opr = await enroll(A.id, 3, 'operator', adm);
const apr = await enroll(A.id, 4, 'approver', adm);
const vwr = await enroll(A.id, 5, 'viewer', adm);
const admB = await enroll(B.id, 6, 'admin');
const T1 = await makeApprover({ BASE, ip: `${NET}.20`, tag: `t1-${R}` });
const EJ = `ejec-${R}@ejemplo.mx`;
createOperator(EJ, 'operador'); // nombre anterior del rol: se acepta y se guarda como ejecutivo
const ej = session(`${NET}.22`, '');
await ej.call('POST', '/v1/auth/login', { email: EJ, password: 'clave-ejecutivo-123' });
check('rol renombrado: operador → ejecutivo', (await ej.call('GET', '/v1/auth/me')).body.operator.role, 'ejecutivo');
const ejSetup = (await ej.call('POST', '/v1/auth/totp/setup', {})).body;
const ejOtp = totp(ejSetup.secret);
await ej.call('POST', '/v1/auth/totp/enable', { code: await ejOtp.next() });

// ═════ Regla de origen: la consola y la API global no originan
const DEST = privateKeyToAccount(generatePrivateKey()).address;
check('API global no crea retiros → 403 origin_not_client', (await api('POST', '/v1/withdrawals', { client_id: A.id, asset_id: ETH, to_address: DEST, amount: E(0.01) }, 'w0')).body.code, 'origin_not_client');
check('ni el tesorero (superusuario) da de alta lista blanca de un cliente → 403 origin_not_client', (await T1.call('POST', '/v1/wallets', { client_id: A.id, chain: 'ethereum', network: 'eth-sepolia', address: DEST, purpose: 'withdrawal_whitelist' })).body.code, 'origin_not_client');
check('la instrucción de consola supera la regla de origen y conserva lista blanca', (await T1.call('POST', '/v1/withdrawals', { client_id: A.id, asset_id: ETH, to_address: DEST, amount: E(0.01) })).body.code, 'address_not_whitelisted');
check('API global no hace transferencias internas → 403', (await api('POST', '/v1/internal-transfers', { from: `client:${A.id}:${ETH}:available`, to: `client:${B.id}:${ETH}:available`, amount: '1' }, 'it')).body.code, 'origin_not_client');

// ═════ Lista blanca
check('viewer no solicita dirección → 403', (await vwr.s.call('POST', '/whitelist', { address: DEST })).status, 403);
const wl = await opr.s.call('POST', '/whitelist', { address: DEST, label: 'Banco corresponsal' });
check('operator solicita dirección → 201 por aprobar', `${wl.status} ${wl.body.state}`, '201 pending_approval');
check('  …duplicada → 409', (await opr.s.call('POST', '/whitelist', { address: DEST })).body.code, 'already_listed');
check('B no puede registrar la misma dirección (sin revelar de quién es) → 409', (await admB.s.call('POST', '/whitelist', { address: DEST })).body.code, 'address_unavailable');
check('operator no aprueba (rol) → 403', (await opr.s.call('POST', `/whitelist/${wl.body.id}/approve`, { code: '123456' })).status, 403);
check('aprobar sin código → 400', (await apr.s.call('POST', `/whitelist/${wl.body.id}/approve`, {})).status, 400);
check('B no ve ni aprueba la dirección de A → 404', (await admB.s.call('POST', `/whitelist/${wl.body.id}/approve`, { code: await admB.otp.next() })).status, 404);
const wlOk = await apr.s.call('POST', `/whitelist/${wl.body.id}/approve`, { code: await apr.otp.next() });
check('approver aprueba con 2FA → en espera (24 h)', `${wlOk.status} ${wlOk.body.state}`, '200 cooling');
// Quien pide no aprueba: el admin pide una segunda dirección y trata de aprobarla él mismo
const DEST2 = privateKeyToAccount(generatePrivateKey()).address;
const wl2 = await adm.s.call('POST', '/whitelist', { address: DEST2 });
check('quien solicitó no aprueba su propia dirección → 403 same_user', (await adm.s.call('POST', `/whitelist/${wl2.body.id}/approve`, { code: await adm.otp.next() })).body.code, 'same_user');
await apr.s.call('POST', `/whitelist/${wl2.body.id}/approve`, { code: await apr.otp.next() });
check('B no ve la lista de A', (await admB.s.call('GET', '/whitelist')).body.entries.length, 0);

// ═════ Simulación
const sim = (s, wid, amt) => s.call('POST', '/exits/simulate', { asset_id: ETH, whitelist_id: wid, amount: amt });
check('dirección en espera no se usa → 422 address_cooling', (await sim(opr.s, wl.body.id, E(0.01))).body.code, 'address_cooling');
await db.query(`UPDATE wallets SET active_from = now() - interval '1 minute' WHERE id = ANY($1)`, [[wl.body.id, wl2.body.id]]);
check('viewer no simula → 403', (await sim(vwr.s, wl.body.id, E(0.01))).status, 403);
check('monto mayor al saldo → 422 insufficient_funds', (await sim(opr.s, wl.body.id, E(2))).body.code, 'insufficient_funds');
const s1 = await sim(opr.s, wl.body.id, E(0.1));
check('simulación → 201 con saldo resultante exacto, hash y vencimiento',
  `${s1.status} ${s1.body.balance_after} ${/^[0-9a-f]{64}$/.test(s1.body.scope_hash)} ${!!s1.body.expires_at} ${s1.body.gas_paid_by}`,
  `201 ${E(0.9)} true true 856`);
check('B no usa la simulación de A → 404', (await admB.s.call('POST', '/exits', { simulation_id: s1.body.id })).status, 404);

// Simulación vencida
const sOld = await sim(opr.s, wl.body.id, E(0.01));
await db.query(`UPDATE exit_simulations SET expires_at = now() - interval '1 second' WHERE id = $1`, [sOld.body.id]);
check('simulación vencida → 409 simulation_expired', (await opr.s.call('POST', '/exits', { simulation_id: sOld.body.id })).body.code, 'simulation_expired');

// ═════ Solicitud → validación de 856 → autorización → ejecución
const x1 = await opr.s.call('POST', '/exits', { simulation_id: s1.body.id });
check('solicitud → 201 en validación de 856, origen usuario', `${x1.status} ${x1.body.state} ${x1.body.origin.kind}`, '201 validation client_user');
check('  …la misma simulación no se usa dos veces → 409', (await opr.s.call('POST', '/exits', { simulation_id: s1.body.id })).body.code, 'already_submitted');
const bal = async () => (await vwr.s.call('GET', '/balances')).body.balances.find((b) => b.asset_id === ETH);
check('saldo reservado al solicitar', `${(await bal()).available} ${(await bal()).reserved}`, `${E(0.9)} ${E(0.1)}`);
const a1 = await ej.call('POST', `/v1/withdrawals/${x1.body.id}/approve`, { code: await ejOtp.next() });
check('ejecutivo de cuenta autoriza con 2FA → aprobada con hash', `${a1.status} ${a1.body.approval_status} ${a1.body.authorized_hash === x1.body.scope_hash}`, '200 approved true');
check('  …el cliente ya no puede cancelar → 409', (await opr.s.call('POST', `/exits/${x1.body.id}/cancel`, {})).body.code, 'not_cancellable');
await tick(); await mine(1); await tick(); await tick();
const done = (await vwr.s.call('GET', `/exits/${x1.body.id}`)).body;
check('ejecutada en cadena (tx y estado visibles para el cliente)', `${done.state} ${/^0x[0-9a-f]{64}$/.test(done.tx_hash)}`, 'executed true');
check('  …llegó al destino', (await chain.getBalance({ address: DEST })).toString(), E(0.1));
check('  …el cliente no ve quién autorizó en 856', 'approved_by' in done || JSON.stringify(done).includes(T1.email), false);

// ═════ Aprobación interna del cliente por umbral
check('solo admin fija umbral → 403', (await opr.s.call('PUT', '/settings/approval-thresholds', { asset_id: ETH, threshold: E(0.05), code: '123456' })).status, 403);
check('admin fija umbral con 2FA', (await adm.s.call('PUT', '/settings/approval-thresholds', { asset_id: ETH, threshold: E(0.05), code: await adm.otp.next() })).body.thresholds[0]?.threshold, E(0.05));
const x2 = await apr.s.call('POST', '/exits', { simulation_id: (await sim(apr.s, wl.body.id, E(0.06))).body.id });
check('arriba del umbral → espera aprobación del cliente', x2.body.state, 'client_approval');
check('  …856 no la ve como pendiente → 409', (await T1.approveWithdrawal(x2.body.id)).body.code, 'not_pending');
check('  …quien originó no la aprueba → 403 same_user', (await apr.s.call('POST', `/exits/${x2.body.id}/approve`, { code: await apr.otp.next() })).body.code, 'same_user');
check('  …operator no aprueba (rol) → 403', (await opr.s.call('POST', `/exits/${x2.body.id}/approve`, { code: '123456' })).status, 403);
const ca = await adm.s.call('POST', `/exits/${x2.body.id}/approve`, { code: await adm.otp.next() });
check('  …otro aprobador (admin) la aprueba con 2FA → validación de 856', `${ca.body.state} ${!!ca.body.client_approver}`, 'validation true');

// ═════ Aprobación individual de 856, sin umbral de dos tesoreros
const x3 = await opr.s.call('POST', '/exits', { simulation_id: (await sim(opr.s, wl.body.id, E(0.04))).body.id }); // bajo umbral del cliente
await adm.s.call('PUT', '/settings/approval-thresholds', { asset_id: ETH, threshold: null, code: await adm.otp.next() });
const x4 = await opr.s.call('POST', '/exits', { simulation_id: (await sim(opr.s, wl2.body.id, E(0.07))).body.id });
check('salida de cliente requiere una autorización de 856', x4.body.authorizations.required, 1);
const d1 = await T1.approveWithdrawal(x4.body.id);
check('  …un tesorero la autoriza con una sola aprobación', d1.body.approval_status, 'approved');
check('  …la segunda aprobación ya no es aceptada → 409', (await T1.approveWithdrawal(x4.body.id)).status, 409);
check('  …el cliente ve 1 de 1', `${(await vwr.s.call('GET', `/exits/${x4.body.id}`)).body.authorizations.given}/${(await vwr.s.call('GET', `/exits/${x4.body.id}`)).body.authorizations.required}`, '1/1');

// ═════ Cambio de alcance y rechazo
const r1 = await apr.s.call('POST', `/whitelist/${wl.body.id}/remove`, {});
check('baja inmediata de la dirección', r1.body.state, 'removed');
check('autorizar con destino dado de baja → 409 scope_changed', (await T1.approveWithdrawal(x3.body.id)).body.code, 'scope_changed');
const rj = await T1.call('POST', `/v1/withdrawals/${x3.body.id}/reject`, { reason: 'Destino dado de baja por el cliente' });
check('tesorero rechaza con motivo', rj.status, 200);
const x3v = (await vwr.s.call('GET', `/exits/${x3.body.id}`)).body;
check('  …el cliente ve rechazada con el motivo', `${x3v.state} ${x3v.rejection_reason}`, 'rejected Destino dado de baja por el cliente');

// ═════ Cancelación por el cliente
const s5 = await sim(opr.s, wl2.body.id, E(0.01));
const x5 = await opr.s.call('POST', '/exits', { simulation_id: s5.body.id });
const before = (await bal()).available;
check('cliente cancela antes de la autorización', (await opr.s.call('POST', `/exits/${x5.body.id}/cancel`, {})).body.state, 'cancelled');
check('  …se libera la reserva', BigInt((await bal()).available) - BigInt(before), E(0.01));

// ═════ Control en profundidad: el worker no firma si la fila no coincide con lo autorizado
const x6 = await opr.s.call('POST', '/exits', { simulation_id: (await sim(opr.s, wl2.body.id, E(0.02))).body.id });
await T1.approveWithdrawal(x6.body.id);
const EVIL = privateKeyToAccount(generatePrivateKey()).address.toLowerCase();
await db.query('UPDATE withdrawals SET to_address = $2 WHERE id = $1', [x6.body.id, EVIL]); // alteración directa en base
await tick();
const x6v = (await vwr.s.call('GET', `/exits/${x6.body.id}`)).body;
check('fila alterada después de autorizar → no se firma, falla y devuelve saldo', `${x6v.state} ${x6v.tx_hash}`, 'failed null');
check('  …nada salió hacia la dirección alterada', (await chain.getBalance({ address: EVIL })).toString(), '0');

// ═════ Llave Ed25519 con permiso withdraw
const pair = generateKeyPairSync('ed25519');
const pub = pair.publicKey.export({ format: 'jwk' }).x;
const proof = (c) => sign(null, Buffer.from(`856-latam/key-proof/v1:${c}`), pair.privateKey).toString('base64url');
let ch = (await adm.s.call('POST', '/keys/challenge', {})).body;
const kW = (await adm.s.call('POST', '/keys', { name: 'ERP tesorería', kind: 'ed25519', permissions: ['read', 'withdraw'], public_key: pub, challenge: ch.challenge, proof: proof(ch.challenge), code: await adm.otp.next() })).body;
const ks = await signed(pair.privateKey, kW.prefix, 'POST', '/exits/simulate', { asset_id: ETH, whitelist_id: wl2.body.id, amount: E(0.01) });
check('llave con withdraw simula → 201', ks.status, 201);
const kx = await signed(pair.privateKey, kW.prefix, 'POST', '/exits', { simulation_id: ks.body.id });
check('  …y solicita: origen = llave', `${kx.status} ${kx.body.origin.kind} ${kx.body.origin.key}`, `201 client_key ${kW.prefix}`);
const pair2 = generateKeyPairSync('ed25519');
ch = (await adm.s.call('POST', '/keys/challenge', {})).body;
const kR = (await adm.s.call('POST', '/keys', { name: 'BI', kind: 'ed25519', permissions: ['read'], public_key: pair2.publicKey.export({ format: 'jwk' }).x, challenge: ch.challenge, proof: sign(null, Buffer.from(`856-latam/key-proof/v1:${ch.challenge}`), pair2.privateKey).toString('base64url'), code: await adm.otp.next() })).body;
check('llave solo lectura no simula → 403', (await signed(pair2.privateKey, kR.prefix, 'POST', '/exits/simulate', { asset_id: ETH, whitelist_id: wl2.body.id, amount: E(0.01) })).status, 403);
check('  …pero sí consulta salidas', (await signed(pair2.privateKey, kR.prefix, 'GET', '/exits')).status, 200);

// ═════ Aislamiento
check('B no ve salidas de A (lista vacía)', (await admB.s.call('GET', '/exits')).body.exits.length, 0);
check('B no consulta una salida de A → 404', (await admB.s.call('GET', `/exits/${x1.body.id}`)).status, 404);
check('B no cancela una salida de A → 404', (await admB.s.call('POST', `/exits/${kx.body.id}/cancel`, {})).status, 404);
check('B no aprueba una salida de A → 404', (await admB.s.call('POST', `/exits/${x2.body.id}/approve`, { code: await admB.otp.next() })).status, 404);

// ═════ Objetivo de respuesta y bitácora
await db.query(`UPDATE withdrawals SET validation_due_at = now() - interval '1 minute' WHERE id = $1`, [kx.body.id]);
check('tablero: salidas fuera de tiempo de respuesta', (await T1.call('GET', '/v1/summary')).body.approvals_pending.exits_overdue >= 1, true);
const { rows: logs } = await db.query(`SELECT action FROM audit_log WHERE client_id = $1 AND action LIKE 'PORTAL POST /v1/portal/exits%'`, [A.id]);
check('bitácora: solicitudes de salida con el cliente', logs.length >= 5, true);

await db.end();
console.log(`\n${ok} ok, ${fail} fallos`);
process.exit(fail ? 1 : 0);
