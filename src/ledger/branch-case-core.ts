// Núcleo puro (sin base de datos ni configuración) del Branch Case: JSON canónico, hash del payload y validación de forma.
// Las reglas que dependen del estado (cliente activo, activos habilitados, contrapartes, cuentas) viven en branch-cases.ts.
import { createHash } from 'node:crypto';
import { z } from 'zod';

export type BranchKind = 'fund_load' | 'internal_transfer' | 'payment_order' | 'mixed';
export type BranchOpType = 'credit_available' | 'internal_transfer' | 'payment_order' | 'debit_adjustment';

export interface BranchLine {
  line_no: number; op_type: BranchOpType; asset_id: string; amount: string;
  from_account_ref: string | null; to_account_ref: string | null; counterparty_code: string | null;
  external_ref: string | null; due_at: string | null; memo: string | null;
}
export interface BranchPayload {
  client_id: string; kind: BranchKind; mandate_ref: string | null;
  source_account: string | null; verbal_reason: string | null; lines: BranchLine[];
}
export interface BranchIssue { linea: number; campo: string; motivo: string }

/** JSON canónico: claves ordenadas recursivamente, sin espacios. Mismo contenido → mismo texto. */
export function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  if (v && typeof v === 'object') {
    return `{${Object.keys(v).sort().filter((k) => (v as Record<string, unknown>)[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${canonicalJson((v as Record<string, unknown>)[k])}`).join(',')}}`;
  }
  return JSON.stringify(v);
}

export const payloadHash = (payload: unknown) => createHash('sha256').update(canonicalJson(payload)).digest('hex');

export const AMOUNT_RE = /^[1-9]\d{0,77}$/;
export const COUNTERPARTY_RE = /^856-[2-9A-HJKMNP-TV-Z]{4}-[2-9A-HJKMNP-TV-Z]{4}$/;
export const normalizeCounterparty = (c: string) => c.trim().toUpperCase();

const KIND_OPS: Record<Exclude<BranchKind, 'mixed'>, BranchOpType> = {
  fund_load: 'credit_available', internal_transfer: 'internal_transfer', payment_order: 'payment_order',
};

const opt = (n: number) => z.string().trim().min(1).max(n).nullish().transform((v) => v ?? null);

const LineSchema = z.strictObject({
  op_type: z.enum(['credit_available', 'internal_transfer', 'payment_order', 'debit_adjustment']),
  asset_id: z.string().regex(/^[A-Z0-9-]{3,40}$/, 'activo inválido'),
  amount: z.string().regex(AMOUNT_RE, 'entero positivo en unidades base, sin decimales'),
  from_account_ref: opt(200), to_account_ref: opt(200), counterparty_code: opt(40), external_ref: opt(200),
  due_at: z.string().datetime({ offset: true }).nullish().transform((v) => (v ? new Date(v).toISOString() : null)),
  memo: opt(500),
});

export const branchCaseSchema = (maxLines: number) => z.strictObject({
  client_id: z.string().uuid(),
  kind: z.enum(['fund_load', 'internal_transfer', 'payment_order', 'mixed']),
  mandate_ref: opt(200),
  client_required: z.boolean().optional(),
  source_account: opt(200),
  reason: z.string().trim().min(5, 'mínimo 5 caracteres').max(500).nullish().transform((v) => v ?? null),
  lines: z.array(LineSchema).min(1, 'al menos una línea').max(maxLines, `máximo ${maxLines} líneas`),
});

/** Reglas de forma por tipo de operación. La línea 0 es el encabezado. */
function lineShapeIssues(kind: BranchKind, l: BranchLine): BranchIssue[] {
  const out: BranchIssue[] = [];
  const bad = (campo: string, motivo: string) => out.push({ linea: l.line_no, campo, motivo });
  if (kind !== 'mixed' && l.op_type !== KIND_OPS[kind]) bad('op_type', `no corresponde al tipo de caso ${kind}`);
  if (l.op_type === 'debit_adjustment') bad('op_type', 'debit_adjustment no está disponible todavía (diferido a P2)');
  if (l.op_type === 'credit_available') {
    if (l.from_account_ref || l.to_account_ref) bad('from_account_ref', 'credit_available no admite cuentas de origen/destino');
    if (l.counterparty_code) bad('counterparty_code', 'credit_available no admite contraparte');
    if (!l.external_ref) bad('external_ref', 'requerido: referencia de evidencia de los fondos');
  }
  if (l.op_type === 'internal_transfer') {
    if (!l.from_account_ref) bad('from_account_ref', 'requerido');
    if (!l.to_account_ref) bad('to_account_ref', 'requerido');
    if (l.from_account_ref && l.from_account_ref === l.to_account_ref) bad('to_account_ref', 'origen y destino deben ser distintos');
    if (l.counterparty_code) bad('counterparty_code', 'internal_transfer no admite contraparte');
  }
  if (l.op_type === 'payment_order') {
    if (!l.counterparty_code) bad('counterparty_code', 'requerido');
    else if (!COUNTERPARTY_RE.test(l.counterparty_code)) bad('counterparty_code', 'formato inválido (856-XXXX-XXXX)');
    if (l.from_account_ref || l.to_account_ref) bad('from_account_ref', 'payment_order no admite cuentas de origen/destino');
  }
  return out;
}

export type ParsedCase =
  | { ok: true; payload: BranchPayload; client_required: boolean | undefined }
  | { ok: false; issues: BranchIssue[] };

/** Valida la forma del cuerpo y lo normaliza al payload canónico (líneas numeradas desde 1). */
export function parseBranchCase(body: unknown, maxLines: number): ParsedCase {
  const r = branchCaseSchema(maxLines).safeParse(body);
  if (!r.success) {
    return {
      ok: false, issues: r.error.issues.map((i) => ({
        linea: i.path[0] === 'lines' && typeof i.path[1] === 'number' ? i.path[1] + 1 : 0,
        campo: i.path[0] === 'lines' && i.path.length > 2 ? String(i.path[2]) : i.path.map(String).join('.') || 'cuerpo',
        motivo: i.message,
      })),
    };
  }
  const d = r.data;
  const lines: BranchLine[] = d.lines.map((l, i) => ({
    line_no: i + 1, op_type: l.op_type, asset_id: l.asset_id, amount: l.amount,
    from_account_ref: l.from_account_ref, to_account_ref: l.to_account_ref,
    counterparty_code: l.counterparty_code ? normalizeCounterparty(l.counterparty_code) : null,
    external_ref: l.external_ref, due_at: l.due_at, memo: l.memo,
  }));
  const issues = lines.flatMap((l) => lineShapeIssues(d.kind, l));
  if (issues.length) return { ok: false, issues };
  return { ok: true, client_required: d.client_required, payload: { client_id: d.client_id, kind: d.kind, mandate_ref: d.mandate_ref, source_account: d.source_account, verbal_reason: d.reason, lines } };
}
