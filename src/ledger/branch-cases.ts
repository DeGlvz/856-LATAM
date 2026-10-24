// Terminal de Caja / Branch Case: operaciones preparadas por un ejecutivo en sucursal, firmadas por el cliente (mandato)
// y liberadas por un tesorero con doble aprobación y 2FA.
// Ciclo: draft → pending_client (si client_required) | pending_treasury → applied | rejected | cancelled.
// 'applying' no se persiste: el apply corre en una sola transacción; si falla, ROLLBACK total y el caso sigue pending_treasury.
// El libro no se toca antes de la aprobación del tesorero. Reutiliza postEntryIn y las reglas de activos habilitados.
import type { Operator } from '../auth/operators.js';
import { config } from '../config.js';
import { pool, tx, type Tx } from '../db.js';
import { HttpError } from '../idempotency.js';
import { decodeCursor, page } from '../pagination.js';
import { assertApprover } from './approvals.js';
import { assetStatus } from './client-assets.js';
import { assertBranchMayOriginate } from './origin.js';
import { LedgerError, assertTransferAssets, ensureSystemAccounts, openClientAccount, postEntryIn } from './service.js';
import {
  parseBranchCase, payloadHash, type BranchIssue, type BranchLine, type BranchPayload,
} from './branch-case-core.js';

export { canonicalJson, payloadHash, parseBranchCase } from './branch-case-core.js';
export type { BranchIssue, BranchPayload } from './branch-case-core.js';

type Q = Tx | typeof pool;
type Row = Record<string, any>;

export class BranchValidationError extends HttpError {
  constructor(public issues: BranchIssue[]) { super(422, 'Caso inválido', 'validation_error'); }
}

const NOT_FOUND = () => new HttpError(404, 'Caso no encontrado', 'not_found');
const conflict = (m: string, code: string) => new HttpError(409, m, code);

const caseView = (r: Row, lines?: Row[]) => ({
  id: r.id, client_id: r.client_id, kind: r.kind, status: r.status, created_by: r.created_by_email,
  payload: r.payload_json, payload_hash: r.payload_hash, mandate_ref: r.mandate_ref, verbal_reason: r.verbal_reason,
  client_required: r.client_required, client_signed_at: r.client_signed_at,
  treasury_required: r.treasury_required, treasury_approved_by: r.treasury_approved_by, treasury_approved_at: r.treasury_approved_at,
  applied_entry_ids: r.applied_entry_ids, applied_obligation_ids: r.applied_obligation_ids, applied_transfer_ids: r.applied_transfer_ids,
  last_error: r.last_error, reject_reason: r.reject_reason, created_at: r.created_at, updated_at: r.updated_at,
  ...(lines ? { lines: lines.map((l) => ({
    line_no: l.line_no, op_type: l.op_type, asset_id: l.asset_id, amount: l.amount, from_account_ref: l.from_account_ref,
    to_account_ref: l.to_account_ref, counterparty_code: l.counterparty_code, external_ref: l.external_ref, due_at: l.due_at,
    memo: l.memo, status: l.status, result_ref: l.result_ref,
  })) } : {}),
});

const creditSource = (p: { source_account: string | null }, asset: string) =>
  (p.source_account ?? config.BRANCH_CREDIT_SOURCE_ACCOUNT).replaceAll('{asset}', asset);

// ───────────── Validación dependiente del estado ─────────────
/** Reglas de negocio sobre cliente, activos, cuentas y contrapartes. Acumula todos los motivos por línea. */
export async function stateIssues(q: Q, p: BranchPayload, clientRequired: boolean): Promise<BranchIssue[]> {
  const issues: BranchIssue[] = [];
  const bad = (linea: number, campo: string, motivo: string) => issues.push({ linea, campo, motivo });
  const { rows: [cl] } = await q.query('SELECT status FROM clients WHERE id = $1', [p.client_id]);
  if (!cl) { bad(0, 'client_id', 'Cliente no encontrado'); return issues; }
  if (cl.status !== 'active') bad(0, 'client_id', `El cliente no está activo (${cl.status})`);

  if (!clientRequired) {
    if (!p.verbal_reason) bad(0, 'reason', 'Sin firma del cliente (instrucción verbal) el motivo es obligatorio');
    const cap = config.BRANCH_VERBAL_MAX_AMOUNT;
    if (cap) for (const l of p.lines) if (BigInt(l.amount) > BigInt(cap)) bad(l.line_no, 'amount', `Excede el tope para instrucción verbal (${cap})`);
  }

  const mandateOps = p.lines.some((l) => l.op_type === 'internal_transfer' || l.op_type === 'payment_order');
  if (config.ORIGIN_RULE === 'enforce' && mandateOps) {
    if (!clientRequired) bad(0, 'client_required', 'Con ORIGIN_RULE=enforce las transferencias y órdenes de pago requieren firma del cliente');
    if (!p.mandate_ref) bad(0, 'mandate_ref', 'Con ORIGIN_RULE=enforce las transferencias y órdenes de pago requieren referencia de mandato');
  }

  const { rows: assets } = await q.query<{ id: string }>('SELECT id FROM assets WHERE id = ANY($1) AND active', [[...new Set(p.lines.map((l) => l.asset_id))]]);
  const activeAssets = new Set(assets.map((a) => a.id));

  for (const l of p.lines) {
    if (!activeAssets.has(l.asset_id)) { bad(l.line_no, 'asset_id', `Activo no disponible: ${l.asset_id}`); continue; }
    const own = await assetStatus(q, p.client_id, l.asset_id);
    if (l.op_type === 'credit_available') {
      if (!config.BRANCH_CREDIT_ENABLED) bad(l.line_no, 'op_type', 'La acreditación de saldo está deshabilitada (BRANCH_CREDIT_ENABLED=false)');
      if (own !== 'enabled') bad(l.line_no, 'asset_id', `El activo ${l.asset_id} no está habilitado para recibir en el cliente`);
      const src = creditSource(p, l.asset_id);
      if (!src.startsWith(`system:${l.asset_id}:`)) bad(l.line_no, 'source_account', `La cuenta de origen debe ser una cuenta system del activo ${l.asset_id}`);
      else if (p.source_account) {
        const { rows: [a] } = await q.query('SELECT client_id, asset_id FROM accounts WHERE code = $1', [src]);
        if (!a || a.client_id !== null || a.asset_id !== l.asset_id) bad(l.line_no, 'source_account', 'Cuenta system no encontrada para el activo');
      }
            } else if (l.op_type === 'internal_transfer') {
      for (const [campo, ref] of [['from_account_ref', l.from_account_ref], ['to_account_ref', l.to_account_ref]] as const) {
        const { rows: [a] } = await q.query('SELECT client_id, asset_id FROM accounts WHERE id::text = $1 OR code = $1', [ref]);
        if (!a) bad(l.line_no, campo, 'Cuenta no encontrada');
        else if (a.client_id !== p.client_id) bad(l.line_no, campo, 'La cuenta no pertenece al cliente del caso (solo entre cuentas del mismo cliente)');
        else if (a.asset_id !== l.asset_id) bad(l.line_no, campo, `La cuenta no es del activo ${l.asset_id}`);
      }
      if (!own) bad(l.line_no, 'asset_id', `El activo ${l.asset_id} no está habilitado para el cliente`);
      else if (own !== 'enabled') bad(l.line_no, 'asset_id', `El activo ${l.asset_id} está en «solo salida»: no puede recibir`);
    } else if (l.op_type === 'payment_order') {
      if (!own) bad(l.line_no, 'asset_id', `El activo ${l.asset_id} no está habilitado para el cliente`);
      const { rows: [cp] } = await q.query('SELECT id, status FROM clients WHERE counterparty_code = $1', [l.counterparty_code]);
      if (!cp || cp.id === p.client_id) bad(l.line_no, 'counterparty_code', 'Código de contraparte no encontrado');
      else if (cp.status === 'closed') bad(l.line_no, 'counterparty_code', 'La contraparte está cerrada');
      else if (!(await assetStatus(q, cp.id, l.asset_id))) bad(l.line_no, 'asset_id', `La contraparte no tiene habilitado ${l.asset_id}`);
    }
  }
  return issues;
}

/** Forma + estado, sin escribir. Devuelve el payload normalizado o las incidencias. */
export async function validateCase(q: Q, body: unknown) {
  const parsed = parseBranchCase(body, config.BRANCH_MAX_LINES);
  if (!parsed.ok) return { ok: false as const, issues: parsed.issues };
  const clientRequired = parsed.client_required ?? config.BRANCH_CLIENT_SIGN_REQUIRED;
  const issues = await stateIssues(q, parsed.payload, clientRequired);
  if (issues.length) return { ok: false as const, issues };
  return { ok: true as const, payload: parsed.payload, clientRequired };
}

// ───────────── Alta y consulta ─────────────
/** Crea el caso en draft dentro de la transacción recibida (la usa también la simulación con rollback). */
export async function createCaseIn(c: Tx, op: Operator, body: unknown, idempotencyKey: string | null) {
  const v = await validateCase(c, body);
  if (!v.ok) throw new BranchValidationError(v.issues);
  const { payload } = v;
  const { rows: [r] } = await c.query(
    `INSERT INTO branch_cases (client_id, created_by, created_by_email, kind, payload_json, payload_hash,     idempotency_key, mandate_ref, client_required, treasury_required, verbal_reason)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,true,$10) RETURNING *`,
        [payload.client_id, op.id, op.email, payload.kind, payload, payloadHash(payload), idempotencyKey, payload.mandate_ref, v.clientRequired, v.clientRequired ? null : payload.verbal_reason]);
  for (const l of payload.lines) {
    await c.query(
      `INSERT INTO branch_case_lines (branch_case_id, line_no, op_type, asset_id, amount, from_account_ref, to_account_ref, counterparty_code, external_ref, due_at, memo)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [r.id, l.line_no, l.op_type, l.asset_id, l.amount, l.from_account_ref, l.to_account_ref, l.counterparty_code, l.external_ref, l.due_at, l.memo]);
  }
  return getCaseIn(c, r.id);
}

export const createCase = (op: Operator, body: unknown, idempotencyKey: string | null) =>
  tx((c) => createCaseIn(c, op, body, idempotencyKey));

async function getCaseIn(q: Q, id: string) {
  const { rows: [r] } = await q.query('SELECT * FROM branch_cases WHERE id = $1', [id]);
  if (!r) throw NOT_FOUND();
  const { rows: lines } = await q.query('SELECT * FROM branch_case_lines WHERE branch_case_id = $1 ORDER BY line_no', [id]);
  return caseView(r, lines);
}
export const getCase = (id: string) => getCaseIn(pool, id);

export async function listCases(f: { status?: string; clientId?: string; limit: number; cursor?: string }) {
  const cur = decodeCursor(f.cursor);
  const { rows } = await pool.query(
    `SELECT *, created_at::text AS _ts FROM branch_cases
      WHERE ($1::text IS NULL OR status = $1) AND ($2::uuid IS NULL OR client_id = $2)
        AND ($3::timestamptz IS NULL OR (created_at, id) < ($3::timestamptz, $4::uuid))
      ORDER BY created_at DESC, id DESC LIMIT $5`,
    [f.status ?? null, f.clientId ?? null, cur?.[0] ?? null, cur?.[1] ?? null, f.limit + 1]);
  const p = page(rows as (Row & { _ts: string; id: string })[], f.limit);
  return { cases: p.items.map((r) => caseView(r)), next_cursor: p.next_cursor };
}

async function lockCase(c: Tx, id: string) {
  const { rows: [r] } = await c.query('SELECT * FROM branch_cases WHERE id = $1 FOR UPDATE', [id]);
  if (!r) throw NOT_FOUND();
  return r;
}

const assertIntegrity = (r: Row) => {
  if (payloadHash(r.payload_json) !== r.payload_hash) throw conflict('La huella del payload no coincide: caso alterado', 'payload_tampered');
};

// ───────────── Transiciones ─────────────
/** draft → pending_client | pending_treasury. Solo quien lo preparó; revalida contra el estado actual. */
export async function submitCase(op: Operator, id: string) {
  return tx(async (c) => {
    const r = await lockCase(c, id);
    if (r.created_by !== op.id) throw new HttpError(403, 'Solo quien preparó el caso puede enviarlo', 'forbidden');
    if (r.status !== 'draft') throw conflict('El caso ya no está en borrador', 'not_draft');
    assertIntegrity(r);
    const issues = await stateIssues(c, r.payload_json, r.client_required);
    if (issues.length) throw new BranchValidationError(issues);
    const next = r.client_required ? 'pending_client' : 'pending_treasury';
    await c.query('UPDATE branch_cases SET status = $2, updated_at = now() WHERE id = $1', [id, next]);
    return getCaseIn(c, id);
  });
}

/** Firma del cliente (la usará el portal en PR2): pending_client → pending_treasury. Sin ruta de consola. */
export async function recordClientSignature(id: string, s: { signerUserId: string; signature: string }) {
  return tx(async (c) => {
    const r = await lockCase(c, id);
    if (r.status !== 'pending_client') throw conflict('El caso no espera la firma del cliente', 'not_pending_client');
    assertIntegrity(r);
    if (!s.signature) throw new HttpError(400, 'Firma requerida', 'signature_required');
    // El firmante debe ser un usuario activo del portal del mismo cliente con rol que pueda autorizar
    const { rows: [u] } = await c.query(`SELECT 1 FROM client_users WHERE id = $1 AND client_id = $2 AND active AND role IN ('approver','admin')`, [s.signerUserId, r.client_id]);
    if (!u) throw new HttpError(403, 'El firmante no pertenece al cliente o no tiene rol para firmar', 'invalid_signer');
    await c.query(
      `UPDATE branch_cases SET status = 'pending_treasury', client_signed_at = now(), client_signer_user_id = $2, client_signature = $3, updated_at = now() WHERE id = $1`,
      [id, s.signerUserId, s.signature]);
    return getCaseIn(c, id);
  });
}

export async function cancelCase(op: Operator, id: string, reason: string) {
  return tx(async (c) => {
    const r = await lockCase(c, id);
    if (r.created_by !== op.id && op.role !== 'tesorero') throw new HttpError(403, 'Solo quien lo preparó o un tesorero puede cancelarlo', 'forbidden');
    if (!['draft', 'pending_client', 'pending_treasury'].includes(r.status)) throw conflict('El caso ya fue resuelto', 'already_decided');
    await c.query(`UPDATE branch_cases SET status = 'cancelled', reject_reason = $2, updated_at = now() WHERE id = $1`, [id, reason]);
    return getCaseIn(c, id);
  });
}

export async function rejectCase(op: Operator, id: string, reason: string) {
  if (op.role !== 'tesorero') throw new HttpError(403, 'Requiere rol tesorero', 'forbidden');
  return tx(async (c) => {
    const r = await lockCase(c, id);
    if (r.status !== 'pending_treasury') throw conflict('El caso no está pendiente de tesorería', 'not_pending_treasury');
    await c.query(`UPDATE branch_cases SET status = 'rejected', reject_reason = $2, updated_at = now() WHERE id = $1`, [id, reason]);
    return getCaseIn(c, id);
  });
}

/**
 * Aprobación del tesorero: doble aprobación (same_operator), 2FA y apply atómico.
 * Si el apply falla, ROLLBACK total, last_error queda registrado y el caso sigue en pending_treasury.
 */
export async function approveCase(op: Operator, id: string, code: string | undefined) {
  if (op.role !== 'tesorero') throw new HttpError(403, 'Requiere rol tesorero', 'forbidden');
  const { rows: [pre] } = await pool.query('SELECT status, created_by, client_required, client_signed_at FROM branch_cases WHERE id = $1', [id]);
  if (!pre) throw NOT_FOUND();
  if (pre.status !== 'pending_treasury') throw conflict('El caso no está pendiente de tesorería', 'not_pending_treasury');
  // Instrucción verbal (sin firma del cliente): el 2FA del tesorero es siempre obligatorio
  const verbal = !pre.client_required && !pre.client_signed_at;
  await assertApprover(op, pre.created_by, code, verbal || (config.BRANCH_APPROVAL_REQUIRE_2FA ?? config.APPROVAL_REQUIRE_2FA));

  let current = 0;
  try {
    return await tx(async (c) => {
      current = 0;
      const r = await lockCase(c, id);
      if (r.status !== 'pending_treasury') throw conflict('El caso no está pendiente de tesorería', 'not_pending_treasury');
      if (r.client_required && !r.client_signed_at) throw conflict('Falta la firma del cliente', 'client_signature_missing');
      assertIntegrity(r);
      await c.query('SELECT 1 FROM clients WHERE id = $1 FOR SHARE', [r.client_id]);
      const issues = await stateIssues(c, r.payload_json, r.client_required);
      if (issues.length) throw new BranchValidationError(issues);

      const { rows: lines } = await c.query('SELECT * FROM branch_case_lines WHERE branch_case_id = $1 ORDER BY line_no FOR UPDATE', [id]);
      const done = { entries: [] as string[], obligations: [] as string[], transfers: [] as string[] };
      for (const l of lines) {
        current = l.line_no;
        await applyLine(c, op, r, l, done);
      }
      await c.query(
        `UPDATE branch_cases SET status = 'applied', treasury_approved_by = $2, treasury_approved_at = now(), last_error = NULL,
                applied_entry_ids = $3, applied_obligation_ids = $4, applied_transfer_ids = $5, updated_at = now() WHERE id = $1`,
        [id, op.id, done.entries, done.obligations, done.transfers]);
      return getCaseIn(c, id);
    });
  } catch (e) {
    const err = ((e as { code?: string }).code === '23514'
      ? new LedgerError(422, 'Saldo insuficiente', 'insufficient_funds') : e) as Error & { statusCode?: number; code?: string };
    if (err.statusCode === 409) throw err; // carrera perdida o estado cambiado: no es un fallo del apply
    const detail = err instanceof BranchValidationError ? err.issues.map((i) => `línea ${i.linea} ${i.campo}: ${i.motivo}`).join('; ') : err.statusCode ? err.message : 'error interno';
    const msg = `${current && !(err instanceof BranchValidationError) ? `línea ${current}: ` : ''}${detail}`.slice(0, 500);
    // Tras el ROLLBACK: se re-bloquea el caso y solo se registra el fallo si sigue pending_treasury,
    // para no pisar un apply exitoso de un reintento concurrente.
    await tx(async (c) => {
      const r = await lockCase(c, id);
      if (r.status !== 'pending_treasury') return;
      await c.query(`UPDATE branch_cases SET last_error = $2, updated_at = now() WHERE id = $1`, [id, msg]);
      await c.query(`UPDATE branch_case_lines SET status = 'pending', result_ref = NULL WHERE branch_case_id = $1 AND status = 'failed'`, [id]);
      if (current) await c.query(`UPDATE branch_case_lines SET status = 'failed', result_ref = $3 WHERE branch_case_id = $1 AND line_no = $2 AND status = 'pending'`, [id, current, err.code ?? 'error']);
    });
    throw err;
  }
}

async function applyLine(c: Tx, op: Operator, r: Row, l: Row, done: { entries: string[]; obligations: string[]; transfers: string[] }) {
  const key = `branchcase:${r.id}:${l.line_no}`;
  const mandate = { caseId: r.id as string, mandateRef: r.mandate_ref as string | null, clientSignedAt: r.client_signed_at as string | null };
  const meta = { branch_case_id: r.id, line_no: l.line_no, mandate_ref: r.mandate_ref };
  const line = l as BranchLine & { amount: string };
  let ref: string;

  if (l.op_type === 'credit_available') {
    await ensureSystemAccounts(c, l.asset_id);
    const acct = await openClientAccount(c, r.client_id, l.asset_id);
    const e = await postEntryIn(c, {
      kind: 'branch_credit', idempotency_key: key, external_ref: l.external_ref ?? undefined, metadata: meta,
      description: `Carga de fondos en sucursal (caso ${r.id}, línea ${l.line_no})${l.memo ? `: ${l.memo}` : ''}`,
      postings: [
        { account: creditSource(r.payload_json, l.asset_id), direction: 'debit', amount: line.amount },
        { account: acct.code, direction: 'credit', amount: line.amount },
      ],
    });
    done.entries.push(e.id); ref = e.id;
  } else if (l.op_type === 'internal_transfer') {
    await assertBranchMayOriginate('internal_transfer', r.client_id, mandate);
    await assertTransferAssets(c, l.from_account_ref, l.to_account_ref);
    const e = await postEntryIn(c, {
      kind: 'transfer', idempotency_key: key, external_ref: l.external_ref ?? undefined, metadata: meta,
      description: `Transferencia interna en sucursal (caso ${r.id}, línea ${l.line_no})${l.memo ? `: ${l.memo}` : ''}`,
      postings: [
        { account: l.from_account_ref, direction: 'debit', amount: line.amount },
        { account: l.to_account_ref, direction: 'credit', amount: line.amount },
      ],
    });
    done.transfers.push(e.id); ref = e.id;
  } else if (l.op_type === 'payment_order') {
    await assertBranchMayOriginate('obligation', r.client_id, mandate);
    const { rows: [prev] } = await c.query(`SELECT id FROM obligations WHERE origin_kind = 'branch_mandate' AND metadata->>'idempotency_key' = $1`, [key]);
    if (prev) ref = prev.id;
    else {
      const { rows: [cp] } = await c.query('SELECT id FROM clients WHERE counterparty_code = $1', [l.counterparty_code]);
      // El cliente (deudor) ya firmó el mandato: nace abierta. Sin firma (caso sin client_required) el deudor debe aceptarla.
      const signed = !!r.client_signed_at;
      const { rows: [o] } = await c.query(
        `INSERT INTO obligations (debtor_id, creditor_id, asset_id, amount, due_at, external_ref, status, accept_due_at, origin_kind, origin_ref, created_by, metadata)
         VALUES ($1,$2,$3,$4,$5,$6,$7, CASE WHEN $7 = 'pending_acceptance' THEN now() + make_interval(secs => $8) END, 'branch_mandate',$9,$10,$11) RETURNING id`,
        [r.client_id, cp.id, l.asset_id, l.amount, l.due_at, l.external_ref, signed ? 'open' : 'pending_acceptance',
          Math.round(config.OBLIGATION_ACCEPT_TTL_HOURS * 3600), r.id, `consola:${op.email}`,
          { ...meta, idempotency_key: key, memo: l.memo }]);
      ref = o.id;
    }
    done.obligations.push(ref);
  } else {
    throw new HttpError(422, `Tipo de operación no soportado: ${l.op_type}`, 'unsupported_op');
  }
  await c.query(`UPDATE branch_case_lines SET status = 'applied', result_ref = $3 WHERE branch_case_id = $1 AND line_no = $2`, [r.id, l.line_no, ref]);
}
