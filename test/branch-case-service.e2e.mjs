// Prueba de servicio (sin HTTP) de Branch Case: firmante, ORIGIN_RULE=enforce y reintento tras fallo.
// Uso: DATABASE_URL ... ORIGIN_RULE=enforce BRANCH_CLIENT_SIGN_REQUIRED=true BRANCH_APPROVAL_REQUIRE_2FA=false
//      BRANCH_CREDIT_ENABLED=true node test/branch-case-service.e2e.mjs   (BD ya migrada; usa dist/)
// La firma del cliente se registra con recordClientSignature (servicio interno): PR1 no tiene ruta de firma.
import { randomUUID } from 'node:crypto';

if (process.env.ORIGIN_RULE !== 'enforce') { console.error('Requiere ORIGIN_RULE=enforce'); process.exit(2); }
const { pool } = await import('../dist/db.js');
const B = await import('../dist/ledger/branch-cases.js');
const ASSET = 'USDC-ETH-SEPOLIA';
const R = Math.random().toString(36).slice(2, 8);
let ok = 0, fail = 0;
const check = (n, got, want) => { if (String(got) === String(want)) { ok++; console.log('✔', n); } else { fail++; console.log(`✘ ${n} — esperado ${want}, obtenido ${got}`); } };
const q = (s, p) => pool.query(s, p);
const count = async (t, w) => Number((await q(`SELECT count(*) FROM ${t} WHERE ${w}`)).rows[0].count);
const fails = async (fn) => { try { await fn(); return 'ok'; } catch (e) { return e.code ?? e.statusCode ?? e.message; } };

const mkOp = async (role) => {
  const { rows: [o] } = await q(`INSERT INTO operators (email, name, password_hash, role) VALUES ($1,$2,'x',$3) RETURNING id`, [`svc-${role}-${R}-${randomUUID().slice(0, 4)}@ejemplo.mx`, role, role]);
  return { id: o.id, email: `svc-${role}`, name: role, role, totp_enabled: false };
};
const mkClient = async (name) => {
  const { rows: [c] } = await q(`INSERT INTO clients (name, status) VALUES ($1,'active') RETURNING id, counterparty_code`, [`${name} ${R}`]);
  await q(`INSERT INTO client_assets (client_id, asset_id, status) VALUES ($1,$2,'enabled')`, [c.id, ASSET]);
  return c;
};
const mkUser = async (client, role, active = true) => (await q(
  `INSERT INTO client_users (client_id, email, name, role, password_hash, active) VALUES ($1,$2,$3,$4,'x',$5) RETURNING id`,
  [client.id, `u-${randomUUID().slice(0, 8)}@ejemplo.mx`, role, role, active])).rows[0].id;

const exe = await mkOp('ejecutivo'), tes = await mkOp('tesorero');
const A = await mkClient('Svc A'), Bc = await mkClient('Svc B'), Other = await mkClient('Svc Otro');
const accA = `client:${A.id}:${ASSET}:available`, reserveA = `client:${A.id}:${ASSET}:reserve`;
const mandate = `MND-${R}`;
const pay = (o = {}) => ({ client_id: A.id, kind: 'payment_order', mandate_ref: mandate, client_required: true,
  lines: [{ op_type: 'payment_order', asset_id: ASSET, amount: '1000', counterparty_code: Bc.counterparty_code, external_ref: `OC-${R}` }], ...o });
const sign = (id, userId) => B.recordClientSignature(id, { signerUserId: userId, signature: 'firma-interna-prueba' });
const signedPending = async (body, userId) => {
  const c = await B.createCase(exe, body, null); await B.submitCase(exe, c.id); await sign(c.id, userId); return c.id;
};

// ── ORIGIN_RULE=enforce: rechazo de instrucción verbal y de mandato ausente
const verbal = await fails(() => B.createCase(exe, pay({ client_required: false, reason: 'instrucción verbal de prueba' }), null));
check('enforce: transferencia/orden verbal rechazada al crear', verbal, 'validation_error');
const v = await B.validateCase(pool, pay({ client_required: false, reason: 'instrucción verbal de prueba' }));
check('enforce: motivo = client_required', v.issues?.some((i) => i.campo === 'client_required'), true);
const nm = await B.validateCase(pool, pay({ mandate_ref: undefined }));
check('enforce: sin mandate_ref rechazado', nm.issues?.some((i) => i.campo === 'mandate_ref'), true);
check('enforce: crédito verbal sigue permitido (no es salida)', (await B.validateCase(pool, {
  client_id: A.id, kind: 'fund_load', client_required: false, reason: 'instrucción verbal de prueba',
  lines: [{ op_type: 'credit_available', asset_id: ASSET, amount: '1', external_ref: 'EV-1' }] })).ok, true);

// ── invalid_signer: otro cliente, inactivo, rol insuficiente, inexistente
const draft = await B.createCase(exe, pay(), null);
await B.submitCase(exe, draft.id);
check('caso firmado requerido → pending_client', (await B.getCase(draft.id)).status, 'pending_client');
for (const [n, uid] of [
  ['firmante de otro cliente', await mkUser(Other, 'approver')],
  ['firmante inactivo', await mkUser(A, 'approver', false)],
  ['rol insuficiente (viewer)', await mkUser(A, 'viewer')],
  ['rol insuficiente (operator)', await mkUser(A, 'operator')],
  ['firmante inexistente', randomUUID()],
]) {
  check(`invalid_signer: ${n}`, await fails(() => sign(draft.id, uid)), 'invalid_signer');
}
const still = await B.getCase(draft.id);
check('tras firmas inválidas sigue pending_client sin firma', `${still.status}/${still.client_signed_at}`, 'pending_client/null');
const goodUser = await mkUser(A, 'approver');
const signed = await sign(draft.id, goodUser);
check('firmante válido → pending_treasury', signed.status, 'pending_treasury');
check('firma registrada', (await q('SELECT client_signer_user_id FROM branch_cases WHERE id = $1', [draft.id])).rows[0].client_signer_user_id, goodUser);

// ── enforce: aprobación con mandato ausente en el registro → rechazo sin efectos
await q('UPDATE branch_cases SET mandate_ref = NULL WHERE id = $1', [draft.id]);
const noMandate = await fails(() => B.approveCase(tes, draft.id, undefined));
check('enforce: apply sin mandate_ref rechazado', noMandate !== 'ok', true);
check('sin obligaciones creadas', await count('obligations', `metadata->>'branch_case_id' = '${draft.id}'`), 0);
check('el caso sigue pending_treasury', (await B.getCase(draft.id)).status, 'pending_treasury');
await q('UPDATE branch_cases SET mandate_ref = $2 WHERE id = $1', [draft.id, mandate]);

// ── enforce: flujo firmado completo mediante el servicio de firma interno
check('same_operator: ejecutivo no aprueba', await fails(() => B.approveCase({ ...exe, role: 'tesorero' }, draft.id, undefined)), 'same_operator');
const applied = await B.approveCase(tes, draft.id, undefined);
check('enforce: flujo firmado → applied', applied.status, 'applied');
const ob = (await q(`SELECT debtor_id, creditor_id, status, origin_kind, origin_ref FROM obligations WHERE id = $1`, [applied.applied_obligation_ids[0]])).rows[0];
check('obligación branch_mandate, cliente deudor, nace open', `${ob.origin_kind}/${ob.origin_ref === draft.id}/${ob.debtor_id === A.id}/${ob.creditor_id === Bc.id}/${ob.status}`, `branch_mandate/true/true/true/open`);

// ── reintento tras fallo: sin efectos parciales y recuperable
for (const [code, name] of [[accA, 'Disponible'], [reserveA, 'Reserva']]) {
  await q(`INSERT INTO accounts (code, client_id, asset_id, type, normal_side, name) VALUES ($1,$2,$3,'liability','credit',$4) ON CONFLICT (code) DO NOTHING`, [code, A.id, ASSET, name]);
}
const mixed = await signedPending({
  client_id: A.id, kind: 'mixed', mandate_ref: mandate, client_required: true,
  lines: [
    { op_type: 'credit_available', asset_id: ASSET, amount: '500', external_ref: `EV-${R}` },
    { op_type: 'internal_transfer', asset_id: ASSET, amount: '900', from_account_ref: accA, to_account_ref: reserveA },
  ],
}, goodUser);
const f1 = await fails(() => B.approveCase(tes, mixed, undefined));
check('fallo por saldo insuficiente', f1, 'insufficient_funds');
const failed = await B.getCase(mixed);
check('tras fallo: pending_treasury con last_error', `${failed.status}/${!!failed.last_error}`, 'pending_treasury/true');
check('tras fallo: línea 1 pending, línea 2 failed', failed.lines.map((l) => l.status).join(','), 'pending,failed');
check('tras fallo: sin asientos ni obligaciones', await count('journal_entries', `idempotency_key LIKE 'branchcase:${mixed}:%'`), 0);
check('tras fallo: sin ids aplicados', `${failed.applied_entry_ids?.length ?? 0}/${failed.applied_transfer_ids?.length ?? 0}`, '0/0');
const f2 = await fails(() => B.approveCase(tes, mixed, undefined));
check('segundo intento falla igual, sin duplicar efectos', `${f2}/${await count('journal_entries', `idempotency_key LIKE 'branchcase:${mixed}:%'`)}`, 'insufficient_funds/0');
// Se reduce el monto del traspaso reemplazando el caso por uno financiado: se acredita saldo con otro caso firmado y se reintenta
const fund = await signedPending({
  client_id: A.id, kind: 'fund_load', client_required: true,
  lines: [{ op_type: 'credit_available', asset_id: ASSET, amount: '1000', external_ref: `EV2-${R}` }],
}, goodUser);
check('crédito firmado aplicado', (await B.approveCase(tes, fund, undefined)).status, 'applied');
const retry = await B.approveCase(tes, mixed, undefined);
check('reintento exitoso → applied', retry.status, 'applied');
check('reintento: líneas applied y last_error limpio', `${retry.lines.map((l) => l.status).join(',')}/${retry.last_error}`, 'applied,applied/null');
check('reintento: un asiento por línea', await count('journal_entries', `idempotency_key LIKE 'branchcase:${mixed}:%'`), 2);
check('aprobar de nuevo → 409', await fails(() => B.approveCase(tes, mixed, undefined)), 'not_pending_treasury');
const after = await B.getCase(mixed);
check('estado final estable tras el reintento', `${after.status}/${after.lines.map((l) => l.status).join(',')}`, 'applied/applied,applied');

console.log(`\n${ok} ok, ${fail} fallos`);
await pool.end();
process.exit(fail ? 1 : 0);
