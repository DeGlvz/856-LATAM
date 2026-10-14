// E2E fase 4 de la consola: obligaciones, simulación, liquidación por el neto, historial y bitácora.
// Uso: BASE KEY DATABASE_URL BOOT_EMAIL BOOT_PASS node test/console-fase4.e2e.mjs  (API con COOKIE_SECURE=false)
// No requiere cadena: la compensación vive solo en el libro.
import { execFileSync } from 'node:child_process';
import pg from 'pg';
import { makeApprover } from './lib/approver.mjs';

const { BASE, KEY, BOOT_EMAIL, BOOT_PASS, DATABASE_URL } = process.env;
const AS = 'USDC-ETH-SEPOLIA';
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
const idem = (k) => ({ 'idempotency-key': `${k}-${R}` });

const tes = browser(`${NET}.1`); check('login tesorero', (await tes.login(BOOT_EMAIL, BOOT_PASS)).status, 200);
const OPR = `op4-${R}@ejemplo.mx`;
createOperator(OPR, 'ejecutivo', 'clave-operador-123');
createOperator(`lec4-${R}@ejemplo.mx`, 'lectura', 'clave-lectura-123');
const opr = browser(`${NET}.2`); await opr.login(OPR, 'clave-operador-123');
const lec = browser(`${NET}.3`); await lec.login(`lec4-${R}@ejemplo.mx`, 'clave-lectura-123');

// ── Clientes activos con cuenta USDC; A con 100 USDC
const mk = async (n) => {
  const c = (await opr.call('POST', '/v1/clients', { name: `F4 ${n} ${R}`, assets: [AS] }, idem(`c${n}`))).body;
  await opr.call('PATCH', `/v1/clients/${c.id}`, { status: 'active' });
  return c;
};
const [A, B, C, D, X] = [await mk('A'), await mk('B'), await mk('C'), await mk('D'), await mk('X')];
const accA = (await tes.call('GET', `/v1/clients/${A.id}`)).body.accounts[0].id;
await tes.call('POST', '/v1/entries', { kind: 'deposit', postings: [
  { account: `system:${AS}:custody`, direction: 'debit', amount: '100000000' }, { account: accA, direction: 'credit', amount: '100000000' }] }, idem('fundA'));
const bal = async (c) => (await tes.call('GET', `/v1/clients/${c.id}`)).body.accounts[0].balance;

// ── Alta de obligaciones y permisos
const ob = (who, d, c, amount, ref, extra = {}) => who.call('POST', '/v1/obligations', { debtor_id: d.id, creditor_id: c.id, asset_id: AS, amount, external_ref: ref, ...extra }, idem(`ob-${ref}`));
check('lectura no registra obligación → 403', (await ob(lec, A, B, '1', `L-${R}`)).status, 403);
check('operador registra A→B 100 (OC-1)', (await ob(opr, A, B, '100000000', `OC-1-${R}`)).status, 201);
await ob(opr, B, C, '100000000', `OC-2-${R}`);
await ob(opr, C, A, '100000000', `OC-3-${R}`);
check('operador registra A→D 30 (FAC-4)', (await ob(opr, A, D, '30000000', `FAC-4-${R}`)).status, 201);
check('deudor inexistente → 404', (await opr.call('POST', '/v1/obligations', { debtor_id: '00000000-0000-4000-8000-000000000000', creditor_id: B.id, asset_id: AS, amount: '1' }, idem('nx'))).status, 404);

// Cliente cerrado no admite nuevas obligaciones (punto 5)
await tes.call('PATCH', `/v1/clients/${X.id}`, { status: 'closed', reason: 'Prueba fase 4' });
const cx = await ob(opr, X, B, '1', `X-${R}`);
check('obligación con cliente cerrado → 409 client_closed', `${cx.status} ${cx.body.code}`, '409 client_closed');

// ── Listado: nombres, filtro por referencia y paginación (punto 6)
let l = (await lec.call('GET', `/v1/obligations?client_id=${A.id}&status=open`)).body;
check('lista de A: 3 abiertas', l.obligations.length, 3);
check('  …trae nombre de deudor y acreedor', !!(l.obligations[0].debtor_name && l.obligations[0].creditor_name), true);
check('filtro por referencia', (await lec.call('GET', `/v1/obligations?external_ref=FAC-4-${R}`)).body.obligations.length, 1);
const p1 = (await lec.call('GET', `/v1/obligations?client_id=${A.id}&limit=2`)).body;
check('paginación: 2 + cursor', `${p1.obligations.length} ${!!p1.next_cursor}`, '2 true');
const p2 = (await lec.call('GET', `/v1/obligations?client_id=${A.id}&limit=2&cursor=${p1.next_cursor}`)).body;
check('  …segunda página sin repetir', `${p2.obligations.length} ${p2.next_cursor} ${p2.obligations[0].id !== p1.obligations[1].id}`, '1 null true');
check('cursor inválido → 400', (await lec.call('GET', '/v1/obligations?cursor=xx')).status, 400);

// ── Cancelación con motivo (punto 7)
const tmp = (await ob(opr, D, C, '5', `TMP-${R}`)).body;
check('cancelar sin motivo → 400', (await opr.call('POST', `/v1/obligations/${tmp.id}/cancel`, {})).status, 400);
check('lectura no cancela → 403', (await lec.call('POST', `/v1/obligations/${tmp.id}/cancel`, { reason: 'No procede' })).status, 403);
const cn = (await opr.call('POST', `/v1/obligations/${tmp.id}/cancel`, { reason: 'OC duplicada' })).body;
check('cancelada con motivo y autor', `${cn.status}|${cn.cancel_reason}|${cn.cancelled_by}`, `cancelled|OC duplicada|${OPR}`);

// Alcance: las 4 obligaciones abiertas de esta prueba (ciclo A→B→C→A más A→D)
const ids = (await lec.call('GET', `/v1/obligations?external_ref=${R}&status=open&asset_id=${AS}`)).body.obligations.map((o) => o.id);
check('alcance: 4 obligaciones abiertas', ids.length, 4);
const S = { asset_id: AS, obligation_ids: ids };

// ── Simulación (punto 2): bloqueo por pagador suspendido
await tes.call('PATCH', `/v1/clients/${A.id}`, { status: 'suspended', reason: 'Revisión KYB' });
check('lectura puede simular (POST de solo consulta)', (await lec.call('POST', '/v1/netting/preview', S)).status, 200);
let pv = (await opr.call('POST', '/v1/netting/preview', S)).body;
check('preview: A bloqueado como pagador neto', pv.positions.find((p) => p.client_id === A.id).blocked, true);
check('  …blocked_clients = [A]', pv.blocked_clients.join(), A.id);
check('  …no liquidable', pv.can_settle, false);
const rb = await tes.call('POST', '/v1/netting/runs', { ...S, expected_net_amount: pv.net_amount }, idem('rb'));
check('corrida con pagador suspendido → 422 client_not_active', `${rb.status} ${rb.body.code}`, '422 client_not_active');
await tes.call('PATCH', `/v1/clients/${A.id}`, { status: 'active' });

pv = (await opr.call('POST', '/v1/netting/preview', S)).body;
check('preview: bruto 330 · neto 30 · ahorro 9090 bps', `${pv.gross_amount} ${pv.net_amount} ${pv.savings_bps}`, '330000000 30000000 9090');
check('  …liquidable y devuelve los ids simulados', `${pv.can_settle} ${pv.obligation_ids.length}`, 'true 4');
check('  …posiciones con nombre de cliente', pv.positions.every((p) => p.client_name.startsWith('F4 ')), true);

// ── Liquidación: permisos, deriva del alcance (punto 3) e ids no abiertos (punto 4)
check('operador no liquida → 403', (await opr.call('POST', '/v1/netting/runs', { ...S, expected_net_amount: pv.net_amount }, idem('ro'))).status, 403);
const drift = await tes.call('POST', '/v1/netting/runs', { ...S, expected_net_amount: '29999999' }, idem('rd'));
check('neto distinto al simulado → 409 scope_changed', `${drift.status} ${drift.body.code}`, '409 scope_changed');
const bad = await tes.call('POST', '/v1/netting/runs', { asset_id: AS, obligation_ids: [...ids, tmp.id] }, idem('rx'));
check('incluye una cancelada → 422 obligations_not_open', `${bad.status} ${bad.body.code}`, '422 obligations_not_open');
check('  …nada se liquidó', (await lec.call('GET', `/v1/obligations?client_id=${A.id}&status=open`)).body.obligations.length, 3);

// Doble aprobación (fase 5): el tesorero solicita y un segundo tesorero con 2FA aprueba
const approver = await makeApprover({ BASE, ip: `${NET}.9`, tag: R });
const run = await tes.call('POST', '/v1/netting/runs', { ...S, expected_net_amount: pv.net_amount }, idem('run'));
check('tesorero solicita la corrida → 202 pendiente', `${run.status} ${run.body.status}`, '202 pending_approval');
check('  …autor de la corrida', run.body.created_by, BOOT_EMAIL.toLowerCase());
const again = await tes.call('POST', '/v1/netting/runs', { ...S, expected_net_amount: pv.net_amount }, idem('run'));
check('reintento con la misma llave → misma corrida', `${again.status} ${again.body.id === run.body.id}`, '202 true');
const appr = (await approver.approveRun(run.body.id)).body;
check('segundo tesorero aprueba → liquidada con asiento', `${appr.status} ${!!appr.entry_id}`, 'settled true');
check('saldos: A 70 · B 0 · C 0 · D 30', [await bal(A), await bal(B), await bal(C), await bal(D)].join(' '), '70000000 0 0 30000000');
check('obligaciones liquidadas por la corrida', (await lec.call('GET', `/v1/obligations?netting_run_id=${run.body.id}`)).body.obligations.length, 4);

// ── Deriva por corte: aparece una obligación nueva entre simular y confirmar
await ob(opr, D, B, '10000000', `OC-5-${R}`);
const cut = new Date(Date.now() + 86400000).toISOString();
const pc = (await opr.call('POST', '/v1/netting/preview', { asset_id: AS, cutoff: cut })).body;
await ob(opr, D, C, '1000000', `OC-6-${R}`);
const dc = await tes.call('POST', '/v1/netting/runs', { asset_id: AS, cutoff: cut, expected_net_amount: pc.net_amount }, idem('rc'));
check('corte con obligación nueva tras simular → 409 scope_changed', `${dc.status} ${dc.body.code}`, '409 scope_changed');

// ── Historial y detalle (punto 1)
const runs = (await lec.call('GET', `/v1/netting/runs?asset_id=${AS}&limit=5`)).body;
check('historial: la corrida aparece primero', runs.runs[0]?.id, run.body.id);
check('  …con ahorro y autor', `${runs.runs[0].savings_bps} ${runs.runs[0].created_by}`, `9090 ${BOOT_EMAIL.toLowerCase()}`);
const det = (await lec.call('GET', `/v1/netting/runs/${run.body.id}`)).body;
check('detalle: posiciones y obligaciones con nombres', `${det.positions.length} ${det.obligations.length} ${!!det.obligations[0].debtor_name}`, '4 4 true');
const ent = (await lec.call('GET', `/v1/entries/${det.entry_id}`)).body;
check('asiento de tipo compensación', ent.kind, 'netting');

// ── Bitácora: la corrida y la cancelación quedaron registradas
const db = new pg.Client({ connectionString: DATABASE_URL }); await db.connect();
const { rows } = await db.query(
  `SELECT actor, action, status FROM audit_log WHERE at > now() - interval '5 minutes'
     AND action IN ('POST /v1/netting/runs', 'POST /v1/obligations/:id/cancel') AND status < 300 ORDER BY id`);
await db.end();
check('bitácora: cancelación por operador', rows.some((r) => r.action.endsWith('/cancel') && r.actor === OPR), true);
check('bitácora: corrida por tesorero', rows.some((r) => r.action === 'POST /v1/netting/runs' && r.actor === BOOT_EMAIL.toLowerCase() && r.status === 202), true);

console.log(`\n${ok} ok, ${fail} fallos`);
process.exit(fail ? 1 : 0);
