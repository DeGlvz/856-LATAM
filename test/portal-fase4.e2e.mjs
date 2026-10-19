// E2E portal de clientes — fase 4: obligaciones originadas por el acreedor, aceptadas por el deudor, carga CSV y compensación.
// Uso: BASE KEY DATABASE_URL node test/portal-fase4.e2e.mjs
//      API con ORIGIN_RULE=enforce, COOKIE_SECURE=false, TOTP_ENCRYPTION_KEY y DUAL_APPROVAL distinto de "all".
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import pg from 'pg';
import { totp } from './lib/totp.mjs';
import { makeApprover } from './lib/approver.mjs';

const { BASE, KEY, DATABASE_URL } = process.env;
const R = Math.random().toString(36).slice(2, 8);
const NET = `10.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`;
let ok = 0, fail = 0;
const check = (n, got, want) => { if (String(got) === String(want)) { ok++; console.log('✔', n); } else { fail++; console.log(`✘ ${n} — esperado ${want}, obtenido ${got}`); } };
const sha = (s) => createHash('sha256').update(s).digest('hex');
const db = new pg.Pool({ connectionString: DATABASE_URL });
const USDC = 'USDC-ETH-SEPOLIA';
const U = (n) => (BigInt(Math.round(n * 1e6))).toString(); // USDC → unidades base (6 decimales)
const PW = 'clave-portal-12345';
const CODE_RE = /^856-[23456789A-HJKMNP-TV-Z]{4}-[23456789A-HJKMNP-TV-Z]{4}$/;

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
async function signed(priv, prefix, method, path, body, extraHeaders = {}) {
  const raw = body ? JSON.stringify(body) : '';
  const ts = String(Math.floor(Date.now() / 1000)), nonce = Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
  const sig = sign(null, Buffer.from(`${method}\n/v1/portal${path}\n${ts}\n${nonce}\n${sha(raw)}`), priv).toString('base64url');
  const r = await fetch(BASE + '/v1/portal' + path, { method, headers: { 'x-forwarded-for': `${NET}.50`, 'x-856-key': prefix, 'x-856-timestamp': ts, 'x-856-nonce': nonce, 'x-856-signature': sig, ...(body ? { 'content-type': 'application/json' } : {}), ...extraHeaders }, body: raw || undefined });
  return { status: r.status, body: await r.json().catch(() => null) };
}

// ═════ Preparación: A acreedor, B deudor, C ajeno
const mk = async (name, idem) => {
  const c = (await api('POST', '/v1/clients', { name: `${name} ${R}`, assets: [USDC] }, idem)).body;
  await api('PATCH', `/v1/clients/${c.id}`, { status: 'active' });
  return c;
};
const A = await mk('Obligaciones Alfa', 'a'), B = await mk('Obligaciones Beta', 'b'), C = await mk('Obligaciones Gamma', 'c');
await api('POST', '/v1/entries', { kind: 'deposit', postings: [
  { account: `client:${B.id}:${USDC}:available`, direction: 'credit', amount: U(500) },
  { account: `system:${USDC}:custody`, direction: 'debit', amount: U(500) }] }, 'fundB');

async function enroll(clientId, n, role, inviter) {
  const email = `p4-${role}-${n}-${R}@ejemplo.mx`;
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
const admA = await enroll(A.id, 2, 'admin');
const oprA = await enroll(A.id, 3, 'operator', admA);
const vwrA = await enroll(A.id, 4, 'viewer', admA);
const admB = await enroll(B.id, 5, 'admin');
const oprB = await enroll(B.id, 6, 'operator', admB);
const aprB = await enroll(B.id, 7, 'approver', admB);
const vwrB = await enroll(B.id, 8, 'viewer', admB);
const admC = await enroll(C.id, 9, 'admin');
const T1 = await makeApprover({ BASE, ip: `${NET}.20`, tag: `t1-${R}` });

// ═════ Códigos de contraparte
const codeA = (await oprA.s.call('GET', '/counterparty')).body.counterparty_code;
const codeB = (await oprB.s.call('GET', '/counterparty')).body.counterparty_code;
check('cada cliente tiene su código de contraparte', CODE_RE.test(codeA) && CODE_RE.test(codeB) && codeA !== codeB, true);
const lk = await oprA.s.call('GET', `/counterparties/${encodeURIComponent(codeB.toLowerCase())}`);
check('confirmar contraparte con el código exacto (sin importar mayúsculas)', `${lk.status} ${lk.body.name}`, `200 Obligaciones Beta ${R}`);
check('  …el propio código no es contraparte → 404', (await oprA.s.call('GET', `/counterparties/${codeA}`)).status, 404);
check('  …código inexistente → 404', (await oprA.s.call('GET', '/counterparties/856-2222-2222')).status, 404);
check('  …texto arbitrario → 404 (no hay búsqueda)', (await oprA.s.call('GET', '/counterparties/Beta')).status, 404);

// ═════ Alta por el acreedor
const newOb = (s, body) => s.call('POST', '/obligations', { counterparty_code: codeB, asset_id: USDC, ...body });
check('consulta (viewer) no registra → 403', (await newOb(vwrA.s, { amount: U(10), external_ref: `X-${R}` })).status, 403);
const o1 = await newOb(oprA.s, { amount: U(100), external_ref: `OC-1-${R}`, due_at: '2026-12-31T00:00:00Z' });
check('acreedor registra → 201 pending_acceptance', `${o1.status} ${o1.body.status} ${o1.body.role}`, '201 pending_acceptance creditor');
const ttlH = (new Date(o1.body.accept_due_at) - Date.now()) / 3600e3;
check('  …plazo de aceptación ≈ 72 h', ttlH > 71.9 && ttlH <= 72, true);
check('  …el acreedor ve su origen', o1.body.origin.user, 'Usuario operator 3');
check('misma referencia con la misma contraparte → 409 duplicate_obligation', (await newOb(oprA.s, { amount: U(5), external_ref: `OC-1-${R}` })).body?.code, 'duplicate_obligation');
check('monto en unidades base inválido → 400', (await newOb(oprA.s, { amount: '1.5' })).status, 400);

// ═════ Aislamiento
check('C no ve la obligación de A y B → 404', (await admC.s.call('GET', `/obligations/${o1.body.id}`)).status, 404);
check('  …ni la acepta → 404', (await admC.s.call('POST', `/obligations/${o1.body.id}/accept`, {})).status, 404);
check('  …ni aparece en su lista', (await admC.s.call('GET', '/obligations')).body.obligations.length, 0);

// ═════ Aceptación por el deudor
check('el acreedor no acepta lo suyo → 403 not_debtor', (await oprA.s.call('POST', `/obligations/${o1.body.id}/accept`, {})).body?.code, 'not_debtor');
const lb = (await oprB.s.call('GET', '/obligations?role=debtor&status=pending_acceptance')).body;
check('el deudor la ve por aceptar (con contador)', `${lb.obligations.length} ${lb.to_accept} ${lb.obligations[0]?.counterparty.name}`, `1 1 Obligaciones Alfa ${R}`);
check('  …sin el detalle de origen del acreedor', lb.obligations[0]?.origin, 'null');
const nb = (await oprB.s.call('GET', '/notices')).body.notices.find((n) => n.code === 'obligations_to_accept');
check('aviso: obligaciones por aceptar', nb?.data.total, 1);
check('consulta (viewer) del deudor no acepta → 403', (await vwrB.s.call('POST', `/obligations/${o1.body.id}/accept`, {})).status, 403);
const a1 = await oprB.s.call('POST', `/obligations/${o1.body.id}/accept`, {});
check('operador del deudor acepta (bajo umbral) → open', `${a1.status} ${a1.body.status}`, '200 open');
check('  …aceptar otra vez → 409 not_pending', (await oprB.s.call('POST', `/obligations/${o1.body.id}/accept`, {})).body?.code, 'not_pending');
check('  …el acreedor la ve abierta', (await oprA.s.call('GET', `/obligations/${o1.body.id}`)).body.status, 'open');

// ═════ Umbral de aprobación interna del deudor
await admB.s.call('PUT', '/settings/approval-thresholds', { asset_id: USDC, threshold: U(50), code: await admB.otp.next() });
const o2 = (await newOb(oprA.s, { amount: U(80), external_ref: `OC-2-${R}` })).body;
check('arriba del umbral: el operador no acepta → 403 approval_required', (await oprB.s.call('POST', `/obligations/${o2.id}/accept`, {})).body?.code, 'approval_required');
check('  …aprobador sin 2FA → 422 bad_code', (await aprB.s.call('POST', `/obligations/${o2.id}/accept`, {})).body?.code, 'bad_code');
check('  …aprobador con 2FA → open', (await aprB.s.call('POST', `/obligations/${o2.id}/accept`, { code: await aprB.otp.next() })).body.status, 'open');

// ═════ Rechazo con motivo
const o3 = (await newOb(oprA.s, { amount: U(7), external_ref: `OC-3-${R}` })).body;
check('rechazar sin motivo → 400', (await oprB.s.call('POST', `/obligations/${o3.id}/reject`, {})).status, 400);
const rj = await oprB.s.call('POST', `/obligations/${o3.id}/reject`, { reason: 'Factura no reconocida' });
check('rechazar con motivo → rejected', rj.body.status, 'rejected');
check('  …el acreedor ve el motivo', (await oprA.s.call('GET', `/obligations/${o3.id}`)).body.rejected_reason, 'Factura no reconocida');

// ═════ Cancelación por el acreedor
const o4 = (await newOb(oprA.s, { amount: U(3), external_ref: `OC-4-${R}` })).body;
check('el deudor no cancela → 403 not_creditor', (await oprB.s.call('POST', `/obligations/${o4.id}/cancel`, { reason: 'No procede pagar' })).body?.code, 'not_creditor');
check('el acreedor cancela con motivo → cancelled', (await oprA.s.call('POST', `/obligations/${o4.id}/cancel`, { reason: 'Registro duplicado' })).body.status, 'cancelled');
check('  …cancelar otra vez → 409 not_cancellable', (await oprA.s.call('POST', `/obligations/${o4.id}/cancel`, { reason: 'Registro duplicado' })).body?.code, 'not_cancellable');

// ═════ Vencimiento de la aceptación
const o5 = (await newOb(oprA.s, { amount: U(4), external_ref: `OC-5-${R}` })).body;
await db.query(`UPDATE obligations SET accept_due_at = now() - interval '1 minute' WHERE id = $1`, [o5.id]);
check('vencida: el deudor ya no acepta → 409 expired', (await oprB.s.call('POST', `/obligations/${o5.id}/accept`, {})).body?.code, 'expired');
check('  …queda expired', (await oprA.s.call('GET', `/obligations/${o5.id}`)).body.status, 'expired');

// ═════ Regla de origen en la consola y la API global
check('tesorero de consola no registra obligaciones → 403 origin_not_client',
  (await T1.call('POST', '/v1/obligations', { debtor_id: B.id, creditor_id: A.id, asset_id: USDC, amount: U(1) })).body?.code, 'origin_not_client');
check('API key global no registra obligaciones → 403 origin_not_client',
  (await api('POST', '/v1/obligations', { debtor_id: B.id, creditor_id: A.id, asset_id: USDC, amount: U(1) }, 'ob-api')).body?.code, 'origin_not_client');
check('la consola sí consulta por estado nuevo', (await T1.call('GET', `/v1/obligations?client_id=${A.id}&status=rejected`)).body.obligations.length, 1);
const sm = (await T1.call('GET', '/v1/summary')).body;
check('tablero: conteo de obligaciones por aceptar', typeof sm.obligations_pending?.total, 'number');

// ═════ Llaves: trade registra y acepta; read y withdraw no
const mkKey = async (adm, perms) => {
  const pair = generateKeyPairSync('ed25519');
  const ch = (await adm.s.call('POST', '/keys/challenge', {})).body;
  const k = (await adm.s.call('POST', '/keys', { name: `Llave ${perms.join('+')}`, kind: 'ed25519', permissions: perms,
    public_key: pair.publicKey.export({ format: 'jwk' }).x, challenge: ch.challenge,
    proof: sign(null, Buffer.from(`856-latam/key-proof/v1:${ch.challenge}`), pair.privateKey).toString('base64url'), code: await adm.otp.next() })).body;
  return (m, p, b, headers) => signed(pair.privateKey, k.prefix, m, p, b, headers);
};
const keyTradeB = await mkKey(admB, ['read', 'trade']);
const keyReadB = await mkKey(admB, ['read']);
const keyWdA = await mkKey(admA, ['read', 'withdraw']);
const simPath = '/obligations/import';
const simCsv = `contraparte,activo,monto\n${codeA},${USDC},1.0000001`;
const invalidSignature = await keyTradeB('POST', simPath, { csv: simCsv }, {
  'x-856-simulate': 'true', 'x-856-signature': 'invalid',
});
check('dry-run rechaza una firma Ed25519 alterada → 401', `${invalidSignature.status} ${invalidSignature.body?.code}`, '401 invalid_signature');
const importsBeforeSimulation = (await db.query('SELECT count(*)::int AS n FROM obligation_imports WHERE client_id = $1', [B.id])).rows[0].n;
const invalidDecimals = await keyTradeB('POST', simPath, { csv: simCsv }, { 'x-856-simulate': 'true' });
check('dry-run informa precisión USDC fuera de 6 decimales → 422',
  `${invalidDecimals.status} ${invalidDecimals.body?.errors?.[0]?.fila} ${invalidDecimals.body?.errors?.[0]?.campo}`,
  '422 2 monto');
check('cada error dry-run contiene solo fila, campo y motivo',
  Object.keys(invalidDecimals.body.errors[0]).sort().join(','), 'campo,fila,motivo');
const validSimulation = await keyTradeB('POST', simPath, { csv: `contraparte,activo,monto\n${codeA},${USDC},1.000001` }, { 'x-856-simulate': 'true' });
check('dry-run válido devuelve huella, cero llamadas y webhook procesado',
  `${validSimulation.status} ${/^[a-f0-9]{64}$/.test(validSimulation.body?.fingerprint)} ${validSimulation.body?.provider_calls} ${validSimulation.body?.emulation?.webhook?.status}`,
  '200 true 0 processed');
check('dry-run exitoso no crea importación durable',
  (await db.query('SELECT count(*)::int AS n FROM obligation_imports WHERE client_id = $1', [B.id])).rows[0].n, importsBeforeSimulation);
check('dry-run exitoso deja únicamente su evento de auditoría',
  (await db.query(`SELECT count(*)::int AS n FROM audit_log WHERE client_id = $1 AND action = 'template_simulation_passed'`, [B.id])).rows[0].n, 1);
const o6 = (await newOb(oprA.s, { amount: U(10), external_ref: `OC-6-${R}` })).body;
check('llave solo lectura no acepta → 403', (await keyReadB('POST', `/obligations/${o6.id}/accept`, {})).status, 403);
check('  …pero consulta obligaciones', (await keyReadB('GET', '/obligations')).status, 200);
check('llave con trade acepta (bajo umbral) → open', (await keyTradeB('POST', `/obligations/${o6.id}/accept`, {})).body?.status, 'open');
check('llave con trade no acepta arriba del umbral → 403 approval_required',
  (await keyTradeB('POST', `/obligations/${(await newOb(oprA.s, { amount: U(60), external_ref: `OC-7-${R}` })).body.id}/accept`, {})).body?.code, 'approval_required');
check('llave con withdraw (sin trade) no registra → 403',
  (await keyWdA('POST', '/obligations', { counterparty_code: codeB, asset_id: USDC, amount: U(1) })).status, 403);
// B también es acreedor de A (para que la compensación tenga ida y vuelta)
const ob = await keyTradeB('POST', '/obligations', { counterparty_code: codeA, asset_id: USDC, amount: U(60), external_ref: `INV-B1-${R}` });
check('llave con trade registra como acreedor → 201', `${ob.status} ${ob.body?.status}`, '201 pending_acceptance');
check('A (sin umbral) acepta la de B', (await oprA.s.call('POST', `/obligations/${ob.body.id}/accept`, {})).body.status, 'open');

// ═════ Carga masiva por CSV
const csv1 = [
  'contraparte;activo;monto;referencia;vencimiento',
  `${codeB};${USDC};12.5;CSV-1-${R};2026-12-01`,
  `${codeB.toLowerCase()};usdc-eth-sepolia;0.000001;CSV-2-${R};`,
  `856-2222-2222;${USDC};1;CSV-3-${R};`,
  `${codeB};${USDC};1.1234567;CSV-4-${R};`,
  `${codeB};${USDC};5;OC-1-${R};`,
  `${codeB};${USDC};6;CSV-1-${R};`,
  `${codeB};${USDC};7;CSV-7-${R};31/12/2026`,
].join('\r\n');
check('carga sin columnas obligatorias → 422 bad_header', (await oprA.s.call('POST', '/obligations/import', { csv: 'a,b\n1,2' })).body?.code, 'bad_header');
check('consulta (viewer) no carga → 403', (await vwrA.s.call('POST', '/obligations/import', { csv: csv1 })).status, 403);
const im = (await oprA.s.call('POST', '/obligations/import', { filename: 'cuentas.csv', csv: '﻿' + csv1 })).body;
check('validación: 7 filas, 2 válidas, 5 con error', `${im.total_rows} ${im.valid_rows} ${im.error_rows}`, '7 2 5');
const errFields = im.errors.map((e) => `${e.row}:${e.field}`).sort().join(',');
check('  …errores por fila y campo', errFields, '4:contraparte,5:monto,6:referencia,7:referencia,8:vencimiento');
check('  …nada se registró todavía', (await db.query('SELECT count(*)::int AS n FROM obligations WHERE external_ref = $1', [`CSV-1-${R}`])).rows[0].n, 0);
check('  …vista previa con unidades base exactas', im.preview.map((p) => p.amount).join(','), `${U(12.5)},1`);
const cm = (await oprA.s.call('POST', `/obligations/import/${im.id}/commit`, {})).body;
check('confirmar → 2 registradas pendientes', `${cm.status} ${cm.created}`, 'committed 2');
check('  …confirmar otra vez → 409 import_closed', (await oprA.s.call('POST', `/obligations/import/${im.id}/commit`, {})).body?.code, 'import_closed');
check('  …B no confirma la carga de A → 404', (await admB.s.call('POST', `/obligations/import/${im.id}/commit`, {})).status, 404);
const im2 = (await oprA.s.call('POST', '/obligations/import', { csv: `contraparte,activo,monto,referencia\n${codeB},${USDC},9,RACE-${R}` })).body;
await newOb(oprA.s, { amount: U(9), external_ref: `RACE-${R}` }); // la fila deja de proceder antes de confirmar
const cm2 = await oprA.s.call('POST', `/obligations/import/${im2.id}/commit`, {});
check('si una fila ya no procede, no se registra ninguna → 409 import_row_failed', cm2.body?.code, 'import_row_failed');
check('  …solo existe la registrada a mano', (await db.query('SELECT count(*)::int AS n FROM obligations WHERE external_ref = $1', [`RACE-${R}`])).rows[0].n, 1);
check('descartar carga', (await oprA.s.call('POST', `/obligations/import/${im2.id}/discard`, {})).body.status, 'discarded');

// ═════ Posición en la próxima corrida y corrida liquidada
// Abiertas de A en USDC: por cobrar 100 + 80 + 10 = 190; por pagar 60 → neto 130, bruto 250, ahorro 120
const pos = (await oprA.s.call('GET', `/netting/positions?asset_id=${USDC}`)).body.positions[0];
check('posición de A: por cobrar, por pagar, neto', `${pos.receivable} ${pos.payable} ${pos.net}`, `${U(190)} ${U(60)} ${U(130)}`);
check('  …ahorro estimado (lo que no se mueve)', `${pos.gross} ${pos.savings} ${pos.open_obligations}`, `${U(250)} ${U(120)} 4`);
const posC = (await admC.s.call('GET', `/netting/positions?asset_id=${USDC}`)).body.positions[0];
check('C (sin obligaciones) ve posición en cero, sin datos ajenos', `${posC.net} ${posC.open_obligations} ${Object.keys(posC).includes('client_name')}`, '0 0 false');
const opens = (await oprA.s.call('GET', `/obligations?status=open&asset_id=${USDC}`)).body.obligations.map((o) => o.id);
const pv = (await api('POST', '/v1/netting/preview', { asset_id: USDC, obligation_ids: opens })).body;
const run = await api('POST', '/v1/netting/runs', { asset_id: USDC, obligation_ids: opens, expected_net_amount: pv.net_amount }, 'run');
check('corrida sobre lo aceptado se liquida', `${run.status} ${run.body.status}`, '201 settled');
const runsA = (await oprA.s.call('GET', '/netting/runs')).body.runs;
check('A ve la corrida donde participó con su neto', `${runsA.length} ${runsA[0]?.net}`, `1 ${U(130)}`);
const rd = (await oprA.s.call('GET', `/netting/runs/${run.body.id}`)).body;
check('  …detalle: su renglón del asiento (abono) y sus obligaciones', `${rd.entry?.kind} ${rd.entry?.amount} ${rd.obligations.length}`, `abono ${U(130)} 4`);
const rdB = (await oprB.s.call('GET', `/netting/runs/${run.body.id}`)).body;
check('B ve la misma corrida como cargo', `${rdB.entry?.kind} ${rdB.entry?.amount} ${rdB.net}`, `cargo ${U(130)} -${U(130)}`);
check('C no ve la corrida → 404', (await admC.s.call('GET', `/netting/runs/${run.body.id}`)).status, 404);
check('liquidada ya no se cancela → 409', (await oprA.s.call('POST', `/obligations/${o1.body.id}/cancel`, { reason: 'Ya no procede' })).body?.code, 'not_cancellable');
check('posición de A vuelve a cero', (await oprA.s.call('GET', `/netting/positions?asset_id=${USDC}`)).body.positions[0].net, '0');

// ═════ Bitácora y migración idempotente
const { rows: logs } = await db.query(`SELECT count(*)::int AS n FROM audit_log WHERE client_id = $1 AND action LIKE 'PORTAL POST /v1/portal/obligations%'`, [A.id]);
check('bitácora: escrituras de obligaciones con el cliente', logs[0].n >= 10, true);
const m014 = (await import(new URL('../dist/migrations/014_portal_obligaciones.js', import.meta.url))).default;
let reRun = 'ok';
try { await db.query(m014); await db.query(m014); } catch (e) { reRun = e.message; }
check('migración 014 se re-ejecuta sin error', reRun, 'ok');

await db.end();
console.log(`\n${ok} ok, ${fail} fallos`);
process.exit(fail ? 1 : 0);
