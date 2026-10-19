// E2E retiro de cliente: cambio de estado normal y retiro forzado (cancela lo abierto, anonimiza o borra).
// Uso: BASE KEY BOOT_EMAIL BOOT_PASS DATABASE_URL node test/client-retire.e2e.mjs  (API con COOKIE_SECURE=false)
const { BASE, KEY, BOOT_EMAIL, BOOT_PASS } = process.env;
const R = Math.random().toString(36).slice(2, 8);
const NET = `10.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`;
let ok = 0, fail = 0;
const check = (n, got, want) => { if (String(got) === String(want)) { ok++; console.log('✔', n); } else { fail++; console.log(`✘ ${n} — esperado ${want}, obtenido ${got}`); } };

let cookie = null;
const call = async (method, path, body, extra = {}) => {
  const r = await fetch(BASE + path, { method, headers: { 'x-forwarded-for': `${NET}.1`, ...(body ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}), ...(method !== 'GET' ? { 'x-856-console': '1' } : {}), ...extra }, body: body && JSON.stringify(body) });
  const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
  return { status: r.status, body: await r.json().catch(() => null) };
};
const key = async (method, path, body, idem) => {
  const r = await fetch(BASE + path, { method, headers: { 'x-api-key': KEY, 'content-type': 'application/json', ...(idem ? { 'idempotency-key': `${idem}-${R}` } : {}) }, body: body && JSON.stringify(body) });
  return { status: r.status, body: await r.json().catch(() => null) };
};

check('login tesorero', (await call('POST', '/v1/auth/login', { email: BOOT_EMAIL, password: BOOT_PASS })).status, 200);
const mk = async (n) => (await key('POST', '/v1/clients', { name: `Retiro ${n} ${R}`, assets: ['USDC-ETH-SEPOLIA'] }, `c-${n}`)).body;
const [A, B, C] = [await mk('A'), await mk('B'), await mk('C')];

// Estado normal sin retirar: activo ↔ suspendido
check('suspender con motivo', (await call('PATCH', `/v1/clients/${A.id}`, { status: 'suspended', reason: 'revisión de cumplimiento' })).body?.status, 'suspended');
check('reactivar', (await call('PATCH', `/v1/clients/${A.id}`, { status: 'active', reason: 'revisión concluida' })).body?.status, 'active');

// Retiro exige motivo
check('retiro sin motivo → 400', (await call('POST', `/v1/clients/${A.id}/retire`, { reason: 'baja' })).status, 400);

// Retiro con obligación abierta: ya no se bloquea; se cancela y el cliente queda anonimizado y cerrado
const ob = (await key('POST', '/v1/obligations', { debtor_id: B.id, creditor_id: C.id, asset_id: 'USDC-ETH-SEPOLIA', amount: '100' }, 'ob')).body;
const r = await call('POST', `/v1/clients/${B.id}/retire`, { reason: 'baja solicitada por el cliente' });
check('retiro con obligación abierta → 200', r.status, 200);
check('conserva el registro anonimizado', r.body?.action, 'anonymized');
check('obligación cancelada', r.body?.resolved?.obligations_cancelled, 1);
check('cliente cerrado y anonimizado', (await call('GET', `/v1/clients/${B.id}`)).body?.status, 'closed');
check('obligación en estado cancelled', (await call('GET', `/v1/obligations/${ob.id}`)).body?.status, 'cancelled');
check('reintento → 409 ya retirado', (await call('POST', `/v1/clients/${B.id}/retire`, { reason: 'baja solicitada por el cliente' })).body?.code, 'already_retired');

// Retiro de un cliente sin operaciones
const r2 = await call('POST', `/v1/clients/${A.id}/retire`, { reason: 'baja solicitada por el cliente' });
check('retiro sin operaciones → 200', r2.status, 200);

console.log(`\n${ok} ok, ${fail} fallos`);
process.exit(fail ? 1 : 0);
