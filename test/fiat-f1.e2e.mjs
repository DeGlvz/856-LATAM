// E2E fase F1: entrada SEPA → EURe (modo tesorería única) con el proveedor SIMULADO. Nunca toca Monerium.
// Uso: BASE KEY DATABASE_URL RPC_B FUNDER_PK EURE TOTP_ENCRYPTION_KEY PROD_DB node test/fiat-f1.e2e.mjs
//   API en sandbox con NETWORKS=eth-sepolia,base-sepolia (Base Sepolia = cadena local B, chainId 31338), WORKER_ENABLED=false,
//   FIAT_LIVE_ENABLED=false y CONFIRMATIONS=1. EURE: token de prueba de 18 decimales desplegado en la cadena B
//   (lo reparte FUNDER_PK). PROD_DB: base vacía para las pruebas de arranque en production (puerto 8088).
import { createHash, createHmac, generateKeyPairSync, sign } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import pg from 'pg';
import { createPublicClient, createWalletClient, erc20Abi, http } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { totp } from './lib/totp.mjs';
import { makeApprover } from './lib/approver.mjs';

const { BASE, KEY, DATABASE_URL, RPC_B, FUNDER_PK, EURE, TOTP_ENCRYPTION_KEY, PROD_DB } = process.env;
const R = Math.random().toString(36).slice(2, 8);
const NET = `10.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`;
let ok = 0, fail = 0;
const check = (n, got, want) => { if (String(got) === String(want)) { ok++; console.log('✔', n); } else { fail++; console.log(`✘ ${n} — esperado ${want}, obtenido ${got}`); } };
const sha = (s) => createHash('sha256').update(s).digest('hex');
const db = new pg.Pool({ connectionString: DATABASE_URL });
const chainB = { id: 31338, name: 'B', nativeCurrency: { name: 'E', symbol: 'E', decimals: 18 }, rpcUrls: { default: { http: [RPC_B] } } };
const pubB = createPublicClient({ chain: chainB, transport: http() });
const walB = createWalletClient({ account: privateKeyToAccount(FUNDER_PK), chain: chainB, transport: http() });
const ASSET = `EURE-T${R.toUpperCase()}`;
const PW = 'clave-portal-12345';
const E18 = (cents) => (BigInt(cents) * 10n ** 16n).toString(); // céntimos → EURe (18 decimales)
const REF_RE = /^856-[23456789A-HJKMNP-TV-Z]{4}-[23456789A-HJKMNP-TV-Z]{4}-\d{3}$/;

const api = async (method, path, body, idem) => {
  const r = await fetch(BASE + path, { method, headers: { 'x-api-key': KEY, 'content-type': 'application/json', ...(idem ? { 'idempotency-key': `${idem}-${R}` } : {}) }, body: body && JSON.stringify(body) });
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
async function signed(priv, prefix, method, path, body) {
  const raw = body ? JSON.stringify(body) : '';
  const ts = String(Math.floor(Date.now() / 1000)), nonce = Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
  const sig = sign(null, Buffer.from(`${method}\n/v1/portal${path}\n${ts}\n${nonce}\n${sha(raw)}`), priv).toString('base64url');
  const r = await fetch(BASE + '/v1/portal' + path, { method, headers: { 'x-forwarded-for': `${NET}.50`, 'x-856-key': prefix, 'x-856-timestamp': ts, 'x-856-nonce': nonce, 'x-856-signature': sig, ...(body ? { 'content-type': 'application/json' } : {}) }, body: raw || undefined });
  return { status: r.status, body: await r.json().catch(() => null) };
}
async function enroll(clientId, n, role, inviter) {
  const email = `f1-${role}-${n}-${R}@ejemplo.mx`;
  const inv = inviter ? (await inviter.s.call('POST', '/users/invites', { email, role })).body : (await api('POST', `/v1/clients/${clientId}/portal-invite`, { email })).body;
  const s = session(`${NET}.${n}`, '/v1/portal');
  await s.call('POST', '/invites/accept', { token: inv.link.split('#')[1], name: `Usuario ${role} ${n}`, password: PW });
  await s.call('POST', '/auth/login', { email, password: PW });
  let otp = null;
  if (role === 'admin' || role === 'approver') {
    const st = (await s.call('POST', '/auth/totp/setup', {})).body; otp = totp(st.secret);
    await s.call('POST', '/auth/totp/enable', { code: await otp.next() });
  }
  return { s, otp, email };
}
const mkKey = async (adm, perms) => {
  const pair = generateKeyPairSync('ed25519');
  const ch = (await adm.s.call('POST', '/keys/challenge', {})).body;
  const k = (await adm.s.call('POST', '/keys', { name: `Llave ${perms.join('+')}`, kind: 'ed25519', permissions: perms,
    public_key: pair.publicKey.export({ format: 'jwk' }).x, challenge: ch.challenge,
    proof: sign(null, Buffer.from(`856-latam/key-proof/v1:${ch.challenge}`), pair.privateKey).toString('base64url'), code: await adm.otp.next() })).body;
  return (m, p, b) => signed(pair.privateKey, k.prefix, m, p, b);
};
/** Acuñación simulada: el «proveedor» transfiere EURe a la tesorería en la cadena B. */
const mint = async (to, cents) => {
  const h = await walB.writeContract({ address: EURE, abi: erc20Abi, functionName: 'transfer', args: [to, BigInt(E18(cents))] });
  await pubB.waitForTransactionReceipt({ hash: h });
  return h;
};
const poll = () => T1.call('POST', '/v1/console/fiat/poll', {});
const balance = async (clientId) => (await db.query(`SELECT balance::text AS b FROM accounts WHERE code = $1`, [`client:${clientId}:${ASSET}:available`])).rows[0]?.b ?? '0';
const depByOrder = async (order) => (await db.query('SELECT * FROM fiat_deposits WHERE provider_order_id = $1', [order])).rows[0];

// ═════ Preparación: activo EURe de prueba en Base Sepolia, tesoreros y clientes
const as = await api('POST', '/v1/assets', { id: ASSET, symbol: 'EURe', chain: 'ethereum', network: 'base-sepolia', kind: 'erc20', contract_address: EURE, decimals: 18 });
check('activo EURe de prueba dado de alta en Base Sepolia', as.status, 201);
await db.query(`UPDATE assets SET active = false WHERE symbol = 'EURe' AND network = 'base-sepolia' AND id <> $1`, [ASSET]); // uno solo vigente
const T1 = await makeApprover({ BASE, ip: `${NET}.20`, tag: `f1t1-${R}` });
const EJ = `ejec-f1-${R}@ejemplo.mx`;
execFileSync('node', ['dist/scripts/create-operator.js', EJ, 'ejecutivo'], { input: 'clave-ejecutivo-123\n', env: process.env, stdio: ['pipe', 'pipe', 'ignore'] });
const ej = session(`${NET}.21`, ''); await ej.call('POST', '/v1/auth/login', { email: EJ, password: 'clave-ejecutivo-123' });

const mk = async (name) => {
  const c = (await api('POST', '/v1/clients', { name: `${name} ${R}`, assets: [ASSET] }, name)).body;
  await api('PATCH', `/v1/clients/${c.id}`, { status: 'active' });
  return c;
};
const A = await mk('Fiat Alfa'), B = await mk('Fiat Beta');
const admA = await enroll(A.id, 2, 'admin'), oprA = await enroll(A.id, 3, 'operator', admA), vwrA = await enroll(A.id, 4, 'viewer', admA);
const admB = await enroll(B.id, 5, 'admin'), oprB = await enroll(B.id, 6, 'operator', admB);
const keyTradeA = await mkKey(admA, ['read', 'trade']);
const keyReadA = await mkKey(admA, ['read']);

// ═════ 1. Antes del alta
const st0 = (await T1.call('GET', '/v1/console/fiat/status')).body;
check('estado: proveedor simulado, sin salir a Monerium', `${st0.provider} ${st0.live} ${st0.live_switch} ${st0.provider_calls}`, 'mock false false 0');
check('  …red de fiat: Base Sepolia en sandbox', st0.network, 'base-sepolia');
check('instrucciones antes del alta → 409 fiat_not_ready', (await oprA.s.call('GET', '/fiat/instructions')).body?.code, 'fiat_not_ready');
check('aviso antes del alta → 409 fiat_not_ready', (await oprA.s.call('POST', '/fiat/payment-intents', { amount: '10' })).body?.code, 'fiat_not_ready');

// ═════ 2. Alta (tesorero con 2FA)
check('alta sin código 2FA → 422 bad_code', (await T1.call('POST', '/v1/console/fiat/setup', {})).body?.code, 'bad_code');
check('alta con API_KEY global → 403 session_required', (await api('POST', '/v1/console/fiat/setup', {})).body?.code, 'session_required');
check('alta por ejecutivo → 403 (requiere tesorero)', (await ej.call('POST', '/v1/console/fiat/setup', {})).status, 403);
const su = await T1.call('POST', '/v1/console/fiat/setup', { code: await T1.code() });
check('alta: dirección ligada (firma de propiedad) e IBAN activo', `${su.status} ${su.body.account?.status} ${/^ZZ00SIMU/.test(su.body.account?.iban)}`, '200 active true');
const TREAS = su.body.account.address;
const w = (await db.query(`SELECT purpose, client_id, derivation_index FROM wallets WHERE address = $1 AND network = 'base-sepolia'`, [TREAS])).rows[0];
check('  …dirección HD reservada de 856 (tesorería fiat, sin cliente)', `${w.purpose} ${w.client_id} ${w.derivation_index != null}`, 'fiat_treasury null true');
const su2 = await T1.call('POST', '/v1/console/fiat/setup', { code: await T1.code() });
check('  …repetir el alta es idempotente (misma dirección)', `${su2.status} ${su2.body.account.address === TREAS}`, '200 true');
check('  …ninguna llamada a Monerium', su2.body.provider_calls, 0);

// ═════ 3. Instrucciones y avisos (solo el cliente)
const ins = (await oprA.s.call('GET', '/fiat/instructions')).body;
check('instrucciones: IBAN, beneficiario, EURe en Base Sepolia', `${ins.iban === su.body.account.iban} ${ins.currency} ${ins.asset_id} ${ins.network}`, `true EUR ${ASSET} base-sepolia`);
check('  …por llave de solo lectura también', (await keyReadA('GET', '/fiat/instructions')).status, 200);
check('aviso por consulta (viewer) → 403', (await vwrA.s.call('POST', '/fiat/payment-intents', { amount: '10' })).status, 403);
check('aviso por llave sin trade → 403', (await keyReadA('POST', '/fiat/payment-intents', { amount: '10' })).status, 403);
check('aviso desde la consola (API_KEY global) → 403 origin_not_client', (await api('POST', '/v1/console/fiat/payment-intents', { amount: '10' })).body?.code, 'origin_not_client');
check('aviso desde la consola (tesorero) → 403 origin_not_client', (await T1.call('POST', '/v1/console/fiat/payment-intents', { amount: '10' })).body?.code, 'origin_not_client');
check('monto con 3 decimales → 400', (await oprA.s.call('POST', '/fiat/payment-intents', { amount: '10.505' })).status, 400);
check('monto con float/coma → 400', (await oprA.s.call('POST', '/fiat/payment-intents', { amount: '1,250.50' })).status, 400);
const i1 = await keyTradeA('POST', '/fiat/payment-intents', { amount: '1250.50', expected_date: '2026-10-20', note: 'Factura 991' });
check('aviso con llave trade → 201, referencia 856-XXXX-XXXX-NNN', `${i1.status} ${REF_RE.test(i1.body.reference)} ${i1.body.expected_amount} ${i1.body.status}`, '201 true 125050 open');
const ttlD = (new Date(i1.body.expires_at) - Date.now()) / 86400e3;
check('  …vence en ≈ 7 días', ttlD > 6.99 && ttlD <= 7, true);
const io = (await db.query('SELECT origin_kind, origin_ip, origin_signature FROM fiat_payment_intents WHERE id = $1', [i1.body.id])).rows[0];
check('  …origen verificable: llave, IP y firma', `${io.origin_kind} ${!!io.origin_ip} ${io.origin_signature?.length > 40}`, 'client_key true true');
const i2 = (await oprA.s.call('POST', '/fiat/payment-intents', { amount: '100' })).body;
check('aviso desde el portal (operator) → origen usuario', (await db.query('SELECT origin_kind FROM fiat_payment_intents WHERE id = $1', [i2.id])).rows[0].origin_kind, 'client_user');

// ═════ 4. Aislamiento
check('B no ve el aviso de A → 404', (await oprB.s.call('GET', `/fiat/payment-intents/${i1.body.id}`)).status, 404);
check('  …ni lo cancela → 404', (await oprB.s.call('POST', `/fiat/payment-intents/${i1.body.id}/cancel`, {})).status, 404);
check('  …ni aparece en su lista', (await oprB.s.call('GET', '/fiat/payment-intents')).body.items.length, 0);

// ═════ 5. Flujo completo: aviso → SEPA → acuñación → conciliación → liberación
const h1 = await mint(TREAS, 125050);
const o1 = (await T1.call('POST', '/v1/console/fiat/simulate', { amount: '1250.50', memo: i1.body.reference, payer_name: 'Alfa SA', payer_iban: 'DE89370400440532013000' })).body;
await poll();
check('orden recibida sin acuñar → received', (await depByOrder(o1.order_id)).status, 'received');
check('  …el portal no la muestra aún', (await oprA.s.call('GET', '/fiat/deposits')).body.items.length, 0);
await T1.call('POST', `/v1/console/fiat/simulate/${o1.order_id}/process`, { tx_hash: h1 });
await poll();
let d1 = await depByOrder(o1.order_id);
check('acuñación verificada on-chain + referencia del aviso → reconciled a A', `${d1.status} ${d1.client_id === A.id} ${d1.match_rule}`, 'reconciled true intent');
check('  …IBAN del pagador enmascarado', d1.payer_iban_masked, 'DE89…3000');
const pd = (await oprA.s.call('GET', '/fiat/deposits')).body.items[0];
check('portal: «Recibido, pendiente de liberación» (sin mover saldo)', `${pd.status_label} ${pd.amount_eur} ${await balance(A.id)}`, 'Recibido, pendiente de liberación 1250.50 0');
check('  …el aviso queda matched', (await oprA.s.call('GET', `/fiat/payment-intents/${i1.body.id}`)).body.status, 'matched');
check('liberar sin 2FA → 422 bad_code', (await T1.call('POST', `/v1/console/fiat/deposits/${d1.id}/release`, {})).body?.code, 'bad_code');
check('liberar por ejecutivo → 403', (await ej.call('POST', `/v1/console/fiat/deposits/${d1.id}/release`, { code: '000000' })).status, 403);
check('liberar con API_KEY global → 403 session_required', (await api('POST', `/v1/console/fiat/deposits/${d1.id}/release`, {})).body?.code, 'session_required');
const rl = await T1.call('POST', `/v1/console/fiat/deposits/${d1.id}/release`, { code: await T1.code() });
check('tesorero libera con 2FA → released y saldo disponible en EURe', `${rl.status} ${rl.body.status} ${await balance(A.id)}`, `200 released ${E18(125050)}`);
check('  …liberar otra vez → 409 not_releasable', (await T1.call('POST', `/v1/console/fiat/deposits/${d1.id}/release`, { code: await T1.code() })).body?.code, 'not_releasable');
check('  …el portal lo ve acreditado', (await keyReadA('GET', '/fiat/deposits')).body.items[0].status_label, 'Acreditado');
const ent = (await db.query(`SELECT count(*)::int AS n FROM journal_entries WHERE idempotency_key = $1`, [`fiat:mock:${o1.order_id}`])).rows[0].n;
check('  …un solo asiento', ent, 1);

// ═════ 6. Sin referencia → revisión → tesorero asigna y libera
const h2 = await mint(TREAS, 30000);
const o2 = (await T1.call('POST', '/v1/console/fiat/simulate', { amount: '300', memo: 'PAGO FACTURA MARZO', tx_hash: h2 })).body;
await poll();
let d2 = await depByOrder(o2.order_id);
check('depósito sin referencia → review', `${d2.status} ${d2.client_id}`, 'review null');
check('  …bandeja de la consola filtra por revisión', (await T1.call('GET', '/v1/console/fiat/deposits?status=review')).body.items.some((x) => x.id === d2.id), true);
check('liberar en revisión sin cliente → 422 client_required', (await T1.call('POST', `/v1/console/fiat/deposits/${d2.id}/release`, { code: await T1.code() })).body?.code, 'client_required');
check('  …asignación sin motivo → 422 reason_required', (await T1.call('POST', `/v1/console/fiat/deposits/${d2.id}/release`, { code: await T1.code(), client_id: B.id })).body?.code, 'reason_required');
const r2 = await T1.call('POST', `/v1/console/fiat/deposits/${d2.id}/release`, { code: await T1.code(), client_id: B.id, reason: 'Confirmado por llamada con Beta' });
check('tesorero asigna a B con motivo → released (manual)', `${r2.status} ${r2.body.status} ${r2.body.match_rule} ${await balance(B.id)}`, `200 released manual ${E18(30000)}`);

// ═════ 7. Código de contraparte en el concepto → asignación automática
const codeB = (await oprB.s.call('GET', '/counterparty')).body.counterparty_code;
const h3 = await mint(TREAS, 4500);
const o3 = (await T1.call('POST', '/v1/console/fiat/simulate', { amount: '45', memo: `Abono ${codeB.replace(/-/g, ' ')}`, tx_hash: h3 })).body;
await poll();
const d3 = await depByOrder(o3.order_id);
check('código de contraparte (aunque el banco quite guiones) → reconciled a B', `${d3.status} ${d3.client_id === B.id} ${d3.match_rule}`, 'reconciled true counterparty');

// ═════ 8. Casos a revisión
const i3 = (await oprA.s.call('POST', '/fiat/payment-intents', { amount: '100' })).body;
const h4 = await mint(TREAS, 9900);
const o4 = (await T1.call('POST', '/v1/console/fiat/simulate', { amount: '99', memo: i3.reference, tx_hash: h4 })).body;
const i4 = (await oprA.s.call('POST', '/fiat/payment-intents', { amount: '20' })).body;
await db.query(`UPDATE fiat_payment_intents SET expires_at = now() - interval '1 minute' WHERE id = $1`, [i4.id]);
const h5 = await mint(TREAS, 2000);
const o5 = (await T1.call('POST', '/v1/console/fiat/simulate', { amount: '20', memo: i4.reference, tx_hash: h5 })).body;
const i6 = (await oprA.s.call('POST', '/fiat/payment-intents', { amount: '15' })).body;
check('cancelar aviso propio → cancelled', (await oprA.s.call('POST', `/fiat/payment-intents/${i6.id}/cancel`, {})).body.status, 'cancelled');
check('  …cancelar otra vez → 409 intent_not_open', (await oprA.s.call('POST', `/fiat/payment-intents/${i6.id}/cancel`, {})).body?.code, 'intent_not_open');
const h6 = await mint(TREAS, 1500);
const o6 = (await T1.call('POST', '/v1/console/fiat/simulate', { amount: '15', memo: i6.reference, tx_hash: h6 })).body;
const badRef = `${i3.reference.slice(0, -3)}${String((Number(i3.reference.slice(-3)) + 1) % 1000).padStart(3, '0')}`;
const h7 = await mint(TREAS, 10000);
const o7 = (await T1.call('POST', '/v1/console/fiat/simulate', { amount: '100', memo: badRef, tx_hash: h7 })).body;
const h8 = await mint(TREAS, 4000); // la orden dice 50 €, se acuñan 40
const o8 = (await T1.call('POST', '/v1/console/fiat/simulate', { amount: '50', memo: i3.reference, tx_hash: h8 })).body;
await poll();
const rv = async (o) => { const d = await depByOrder(o.order_id); return `${d.status}|${d.client_id ?? '-'}|${d.review_reason}`; };
check('monto distinto al del aviso → review', (await rv(o4)).startsWith('review|-|monto 99.00 distinto'), true);
check('aviso vencido → review', (await rv(o5)).startsWith('review|-|aviso') && (await rv(o5)).includes('vencido'), true);
check('aviso cancelado → review', (await rv(o6)).includes('cancelado por el cliente'), true);
check('referencia con dígitos de control alterados → review', (await rv(o7)).includes('dígitos de control'), true);
check('monto acuñado distinto al de la orden → review', (await rv(o8)).includes('monto acuñado (40.00 €) distinto al de la orden (50.00 €)'), true);
check('  …el aviso de 100 € sigue abierto', (await oprA.s.call('GET', `/fiat/payment-intents/${i3.id}`)).body.status, 'open');

// ═════ 9. Idempotencia: orden repetida y transacción repetida
await poll(); await poll();
check('sondeos repetidos: un registro por orden', (await db.query('SELECT count(*)::int AS n FROM fiat_deposits WHERE provider_order_id = ANY($1)', [[o1.order_id, o2.order_id]])).rows[0].n, 2);
const o9 = (await T1.call('POST', '/v1/console/fiat/simulate', { amount: '1250.50', memo: 'otra orden con la tx ya usada', tx_hash: h1 })).body;
await poll();
const d9 = await depByOrder(o9.order_id);
check('otra orden con un hash ya usado → review (tx duplicada)', `${d9.status} ${d9.tx_hash} ${d9.review_reason.includes('ya ligada')}`, 'review null true');
check('  …no se puede liberar (sin acuñación propia) → 409 not_minted', (await T1.call('POST', `/v1/console/fiat/deposits/${d9.id}/release`, { code: await T1.code(), client_id: A.id, reason: 'Intento de doble acreditación' })).body?.code, 'not_minted');
check('  …saldo de A intacto', await balance(A.id), E18(125050));
const tot = (await db.query(`SELECT count(*)::int AS n FROM journal_entries WHERE idempotency_key LIKE 'fiat:mock:%'`)).rows[0].n;
check('  …asientos fiat: solo los liberados (2)', tot, 2);

// ═════ 10. Rechazo y webhook
const rj0 = await T1.call('POST', `/v1/console/fiat/deposits/${d9.id}/reject`, { code: await T1.code() });
check('rechazar sin motivo → 400', rj0.status, 400);
const rj = await T1.call('POST', `/v1/console/fiat/deposits/${d9.id}/reject`, { code: await T1.code(), reason: 'Orden duplicada del proveedor' });
check('tesorero rechaza con motivo → rejected', `${rj.status} ${rj.body.status} ${rj.body.reason}`, '200 rejected Orden duplicada del proveedor');
// Formato Standard Webhooks: HMAC-SHA256 de `${webhook-id}.${webhook-timestamp}.${cuerpo}` con el secreto whsec_ (base64)
const whBody = JSON.stringify({ type: 'order.updated', data: { id: o1.order_id } });
const whSend = (headers) => fetch(BASE + '/v1/webhooks/monerium', { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: whBody });
const whSig = (id, ts, secret) => `v1,${createHmac('sha256', Buffer.from(secret.replace(/^whsec_/, ''), 'base64')).update(`${id}.${ts}.${whBody}`).digest('base64')}`;
const WHS = process.env.MONERIUM_WEBHOOK_SECRET;
if (WHS) {
  const ts = String(Math.floor(Date.now() / 1000));
  const good = await whSend({ 'webhook-id': `msg_${R}`, 'webhook-timestamp': ts, 'webhook-signature': whSig(`msg_${R}`, ts, WHS) });
  check('webhook de Monerium con firma válida → 200 verificado (solo adelanta el sondeo)', `${good.status} ${(await good.json()).verified}`, '200 true');
  check('  …firma con otro secreto → 401', (await whSend({ 'webhook-id': `msg_${R}`, 'webhook-timestamp': ts, 'webhook-signature': whSig(`msg_${R}`, ts, 'whsec_b3Ryb3NlY3JldG8=') })).status, 401);
  const old = String(Math.floor(Date.now() / 1000) - 900);
  check('  …firma vieja (> 5 min) → 401', (await whSend({ 'webhook-id': `msg_${R}`, 'webhook-timestamp': old, 'webhook-signature': whSig(`msg_${R}`, old, WHS) })).status, 401);
  check('  …sin firma → 401', (await whSend({})).status, 401);
} else {
  const wh = await whSend({});
  check('webhook de Monerium sin secreto: solo adelanta el sondeo (no mueve estado)', `${wh.status} ${(await wh.json()).verified}`, '200 false');
}
check('  …el depósito no cambió por el aviso', (await depByOrder(o1.order_id)).status, 'released');
check('estado final: ninguna llamada a Monerium (FIAT_LIVE_ENABLED=false)', (await T1.call('GET', '/v1/console/fiat/status')).body.provider_calls, 0);

// ═════ 11. Barrido: la tesorería fiat se concentra en la hot wallet (custodia = libro tras liberar)
const sw = (await db.query(`SELECT count(*)::int AS n FROM wallets WHERE purpose = 'fiat_treasury' AND network = 'base-sepolia' AND derivation_index IS NOT NULL`)).rows[0].n;
check('la tesorería fiat entra al barrido como dirección derivada', sw, 1);

// ═════ 12. Reglas de arranque del fiat
const TEST_MNEMONIC = 'test test test test test test test test test test test junk';
const clean = (e) => Object.fromEntries(Object.entries(e).filter(([, v]) => v !== undefined));
const prodEnv = (extra = {}) => clean({
  PATH: process.env.PATH, HOME: process.env.HOME, DATABASE_URL: PROD_DB, PORT: '8088', HOST: '127.0.0.1', API_KEYS: KEY,
  ALCHEMY_API_KEY: 'llave-de-prueba-sin-red', ENVIRONMENT: 'production', ALCHEMY_NETWORK: 'eth-mainnet', NETWORKS: 'base-mainnet,arb-mainnet,bnb-mainnet',
  ORIGIN_RULE: 'enforce', TOTP_ENCRYPTION_KEY, COOKIE_SECURE: 'false', WORKER_ENABLED: 'false', SIGNER_PRIVATE_KEY: generatePrivateKey(), HD_MNEMONIC: TEST_MNEMONIC, ...extra,
});
const boot = (env, ms = 45_000) => new Promise((resolve) => {
  const p = spawn('node', ['dist/server.js'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  const done = (code) => { clearTimeout(t); p.kill('SIGTERM'); resolve({ code, out }); };
  const t = setTimeout(() => done('timeout'), ms);
  const on = (d) => { out += d; if (out.includes('Server listening')) done('listening'); };
  p.stdout.on('data', on); p.stderr.on('data', on); p.on('exit', (c) => done(c));
});
let b = await boot(prodEnv({ ENVIRONMENT: 'sandbox', ALCHEMY_NETWORK: 'eth-sepolia', NETWORKS: 'base-sepolia', FIAT_LIVE_ENABLED: 'true' }));
check('sandbox con FIAT_LIVE_ENABLED=true → arranque rechazado', `${b.code} ${b.out.includes('proveedor simulado')}`, '1 true');
b = await boot(prodEnv({ FIAT_LIVE_ENABLED: 'true' }));
check('production con fiat encendido sin credenciales de Monerium → rechazado', `${b.code} ${b.out.includes('MONERIUM_CLIENT_ID')}`, '1 true');
b = await boot(prodEnv({ FIAT_LIVE_ENABLED: 'true', MONERIUM_CLIENT_ID: 'id-prueba', MONERIUM_CLIENT_SECRET: 'secreto-prueba', MONERIUM_ENV: 'sandbox' }));
check('production con Monerium sandbox → rechazado', `${b.code} ${b.out.includes('MONERIUM_ENV debe ser production')}`, '1 true');
b = await boot(prodEnv({ FIAT_LIVE_ENABLED: 'true', MONERIUM_CLIENT_ID: 'id-prueba', MONERIUM_CLIENT_SECRET: 'secreto-prueba', NETWORKS: 'arb-mainnet' }));
check('production con fiat sin Base encendida → rechazado', `${b.code} ${b.out.includes('base-mainnet encendida')}`, '1 true');
b = await boot(prodEnv({ FIAT_MODE: 'per_client' }));
check('FIAT_MODE=per_client (declarado, no implementado) → rechazado', `${b.code} ${b.out.includes('per_client')}`, '1 true');

await db.end();
console.log(`\n${ok} ok, ${fail} fallas`);
process.exit(fail ? 1 : 0);
