// Rieles fiat múltiples: interruptores, cuentas bancarias cifradas y versionadas, y rieles activos para el portal.
// Las cuentas se guardan cifradas (AES-256-GCM, FIAT_RAILS_ENC_KEY); la bitácora solo registra campos cambiados y last4.
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { z } from 'zod';
import { audit, type Operator } from '../auth/operators.js';
import { config } from '../config.js';
import { pool, tx } from '../db.js';
import { HttpError } from '../idempotency.js';

// ───────────── Cifrado ─────────────
function key(): Buffer {
  if (!config.FIAT_RAILS_ENC_KEY) {
    throw new HttpError(503, 'El servidor no tiene configurada FIAT_RAILS_ENC_KEY: las cuentas de rieles fiat están deshabilitadas', 'fiat_rails_key_missing');
  }
  return createHash('sha256').update(config.FIAT_RAILS_ENC_KEY).digest();
}
export const railsKeyConfigured = () => !!config.FIAT_RAILS_ENC_KEY;

// El AAD liga el blob a su riel y versión: copiarlo a otra fila no descifra
const aad = (railId: string, version: number) => Buffer.from(`fiat-rail:${railId}:${version}`);
export function encryptDetails(railId: string, version: number, details: Record<string, string>): string {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key(), iv);
  c.setAAD(aad(railId, version));
  const ct = Buffer.concat([c.update(JSON.stringify(details), 'utf8'), c.final()]);
  return ['v1', iv.toString('base64url'), c.getAuthTag().toString('base64url'), ct.toString('base64url')].join(':');
}
export function decryptDetails(railId: string, version: number, enc: string): Record<string, string> {
  const [v, iv, tag, ct] = enc.split(':');
  if (v !== 'v1') throw new Error('Formato de cuenta desconocido');
  const d = createDecipheriv('aes-256-gcm', key(), Buffer.from(iv, 'base64url'));
  d.setAAD(aad(railId, version));
  d.setAuthTag(Buffer.from(tag, 'base64url'));
  return JSON.parse(Buffer.concat([d.update(Buffer.from(ct, 'base64url')), d.final()]).toString('utf8'));
}

// ───────────── Campos por tipo de riel ─────────────
const txt = (max = 140) => z.string().trim().min(1).max(max);
const opt = (max = 140) => z.string().trim().min(1).max(max).optional();
const FIELD_SCHEMAS = {
  wire: z.object({
    beneficiary_name: txt(), bank_name: txt(), account_number: txt(40), aba: z.string().regex(/^\d{9}$/, 'ABA de 9 dígitos'),
    swift: z.string().regex(/^[A-Za-z0-9]{8}([A-Za-z0-9]{3})?$/, 'SWIFT/BIC de 8 u 11 caracteres'),
    intermediary_bank: opt(), intermediary_swift: opt(20), bank_address: opt(300),
  }).strict(),
  ach: z.object({
    beneficiary_name: txt(), bank_name: txt(), account_number: txt(40), aba: z.string().regex(/^\d{9}$/, 'ABA de 9 dígitos'),
    account_type: z.enum(['checking', 'savings']).optional(),
  }).strict(),
  sepa: z.object({
    beneficiary_name: txt(), iban: z.string().trim().toUpperCase().regex(/^[A-Z]{2}\d{2}[A-Z0-9]{10,30}$/, 'IBAN inválido'),
    bic: z.string().regex(/^[A-Za-z0-9]{8}([A-Za-z0-9]{3})?$/, 'BIC de 8 u 11 caracteres'), bank_name: opt(),
  }).strict(),
  spei: z.object({
    beneficiary_name: txt(), clabe: z.string().regex(/^\d{18}$/, 'CLABE de 18 dígitos'), bank_name: opt(),
  }).strict(),
  pix: z.object({
    beneficiary_name: txt(), pix_key: txt(77), key_type: z.enum(['cpf_cnpj', 'email', 'phone', 'random']).optional(),
  }).strict(),
  generic: z.object({
    beneficiary_name: txt(), bank_name: opt(), account_number: opt(60), details: opt(500),
  }).strict(),
} as const;
type RailType = keyof typeof FIELD_SCHEMAS;
const schemaFor = (railType: string) => FIELD_SCHEMAS[(railType === 'otc' ? 'generic' : railType) as RailType];

const LABELS: Record<string, string> = {
  beneficiary_name: 'Beneficiario', bank_name: 'Banco', account_number: 'Cuenta', aba: 'ABA', swift: 'SWIFT/BIC', bic: 'BIC',
  intermediary_bank: 'Banco intermediario', intermediary_swift: 'SWIFT intermediario', bank_address: 'Dirección del banco',
  account_type: 'Tipo de cuenta', iban: 'IBAN', clabe: 'CLABE', pix_key: 'Llave PIX', key_type: 'Tipo de llave', details: 'Detalles',
};
const ID_FIELDS = ['account_number', 'iban', 'clabe', 'pix_key'];
const last4Of = (d: Record<string, string>) => {
  const v = ID_FIELDS.map((f) => d[f]).find(Boolean) ?? d.beneficiary_name ?? '';
  return v.replace(/\s+/g, '').slice(-4);
};

export function parseDetails(railType: string, input: unknown): Record<string, string> {
  const r = schemaFor(railType).safeParse(input);
  if (!r.success) throw new HttpError(400, r.error.issues.map((i) => `${i.path.join('.') || 'cuenta'}: ${i.message}`).join('; '), 'validation_error');
  return r.data as Record<string, string>;
}

// ───────────── Consola ─────────────
const RAIL_COLS = `rail_id, label, currency, country, rail_type, kind, priority, fallback_of, is_enabled, visibility, maintenance_message,
  min_amount::text AS min_amount, max_amount::text AS max_amount, recommended_for, settlement_time, requires_review, is_archived, updated_at, updated_by`;

/** Vista de consola: la cuenta viaja enmascarada (solo last4, versión y propuestas pendientes con campos cambiados). */
export async function listRails() {
  const { rows: rails } = await pool.query(`SELECT ${RAIL_COLS} FROM fiat_rails ORDER BY currency, priority, rail_id`);
  const { rows: accs } = await pool.query(
    `SELECT rail_id, version, last4, status, changed_fields, created_by, created_at, approved_by, approved_at, proposal_reason
       FROM fiat_rail_accounts WHERE status IN ('active','proposed') ORDER BY rail_id, version DESC`);
  return {
    key_configured: railsKeyConfigured(),
    rails: rails.map((r) => {
      const mine = accs.filter((a) => a.rail_id === r.rail_id);
      const active = mine.find((a) => a.status === 'active');
      return {
        ...r,
        account: active ? { version: active.version, last4: active.last4, approved_by: active.approved_by, approved_at: active.approved_at } : null,
        pending_proposal: mine.filter((a) => a.status === 'proposed').map((a) => ({
          version: a.version, last4: a.last4, changed_fields: a.changed_fields, created_by: a.created_by, created_at: a.created_at, reason: a.proposal_reason,
        }))[0] ?? null,
      };
    }),
  };
}

export interface RailPatch {
  is_enabled?: boolean; visibility?: 'all' | 'restricted'; maintenance_message?: string | null; min_amount?: string | null; max_amount?: string | null;
  recommended_for?: string | null; settlement_time?: string | null; priority?: number; fallback_of?: string | null;
  label?: string; currency?: string; country?: string | null; rail_type?: string; requires_review?: boolean; is_archived?: boolean;
}
// Los rieles automáticos (Monerium, OTC) solo admiten interruptor, mensaje, límites y visibilidad.
const AUTOMATIC_EDITABLE = ['is_enabled', 'maintenance_message', 'min_amount', 'max_amount', 'visibility'];

export async function createRail(op: Operator, input: RailCreate, reason: string, ip?: string) {
  const out = await tx(async (c) => {
    const { rows: [dup] } = await c.query('SELECT 1 FROM fiat_rails WHERE rail_id = $1', [input.rail_id]);
    if (dup) throw new HttpError(409, 'Ya existe un riel con ese rail_id', 'rail_exists');
    if (input.fallback_of) {
      const { rows: [f] } = await c.query('SELECT 1 FROM fiat_rails WHERE rail_id = $1', [input.fallback_of]);
      if (!f) throw new HttpError(400, 'fallback_of no existe', 'validation_error');
    }
    if (input.min_amount != null && input.max_amount != null && Number(input.min_amount) > Number(input.max_amount)) {
      throw new HttpError(400, 'min_amount no puede superar max_amount', 'validation_error');
    }
    const { rows: [r] } = await c.query(
      `INSERT INTO fiat_rails (rail_id, label, currency, country, rail_type, kind, priority, fallback_of, is_enabled, visibility, maintenance_message,
              min_amount, max_amount, recommended_for, settlement_time, requires_review, updated_by)
       VALUES ($1,$2,$3,$4,$5,'manual',$6,$7,false,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING ${RAIL_COLS}`,
      [input.rail_id, input.label, input.currency, input.country ?? null, input.rail_type, input.priority ?? 100, input.fallback_of ?? null,
        input.visibility ?? 'all', input.maintenance_message ?? null, input.min_amount ?? null, input.max_amount ?? null,
        input.recommended_for ?? null, input.settlement_time ?? null, input.requires_review ?? true, op.email]);
    return r;
  });
  const { updated_at: _a, updated_by: _b, ...after } = out;
  await audit({ operator_id: op.id, actor: op.email, action: 'fiat_rail_created', target: input.rail_id, status: 201, ip, metadata: { reason, before: null, after } });
  return { rail: out };
}

export interface RailCreate {
  rail_id: string; label: string; currency: string; country?: string | null; rail_type: string; priority?: number; fallback_of?: string | null;
  visibility?: 'all' | 'restricted'; maintenance_message?: string | null; min_amount?: string | null; max_amount?: string | null;
  recommended_for?: string | null; settlement_time?: string | null; requires_review?: boolean;
}

export async function toggleRail(op: Operator, railId: string, patch: RailPatch, reason: string, ip?: string) {
  const out = await tx(async (c) => {
    const { rows: [before] } = await c.query(`SELECT ${RAIL_COLS} FROM fiat_rails WHERE rail_id = $1 FOR UPDATE`, [railId]);
    if (!before) throw new HttpError(404, 'Riel no encontrado', 'not_found');
    const next = { ...before, ...Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)) };
    if (before.kind === 'automatic') {
      const bad = Object.keys(patch).filter((k) => (patch as Record<string, unknown>)[k] !== undefined && !AUTOMATIC_EDITABLE.includes(k));
      if (bad.length) throw new HttpError(409, `Un riel automático solo permite editar interruptor, mensaje, límites y visibilidad (${bad.join(', ')})`, 'rail_locked');
    }
    if (before.is_archived && patch.is_archived !== false && Object.keys(patch).some((k) => (patch as Record<string, unknown>)[k] !== undefined)) {
      throw new HttpError(409, 'El riel está archivado: restáurelo antes de editarlo', 'rail_archived');
    }
    if (patch.is_archived === true) {
      next.is_enabled = false;
      const { rows: [o] } = await c.query(`SELECT count(*)::int AS n FROM fiat_payment_intents WHERE status = 'open' AND currency = $1`, [before.currency]);
      if (o.n > 0) throw new HttpError(409, 'No se puede archivar: hay avisos de pago abiertos en esa moneda', 'rail_has_open_intents');
    }
    if (patch.is_archived === false) next.is_enabled = false; // al restaurar vuelve apagado
    if (patch.rail_type && patch.rail_type !== before.rail_type) {
      const { rows: [a] } = await c.query('SELECT 1 FROM fiat_rail_accounts WHERE rail_id = $1 LIMIT 1', [railId]);
      if (a) throw new HttpError(409, 'No se puede cambiar el tipo de un riel que ya tiene cuentas cargadas', 'rail_has_account');
    }
    if (patch.currency && patch.currency !== before.currency && before.is_enabled) {
      throw new HttpError(409, 'Apague el riel antes de cambiar su moneda', 'rail_enabled');
    }
    if (patch.fallback_of) {
      const { rows: [f] } = await c.query('SELECT 1 FROM fiat_rails WHERE rail_id = $1', [patch.fallback_of]);
      if (!f) throw new HttpError(400, 'fallback_of no existe', 'validation_error');
    }
    if (patch.fallback_of === railId) throw new HttpError(400, 'Un riel no puede ser alterno de sí mismo', 'validation_error');
    if (next.min_amount != null && next.max_amount != null && Number(next.min_amount) > Number(next.max_amount)) {
      throw new HttpError(400, 'min_amount no puede superar max_amount', 'validation_error');
    }
    if (patch.is_enabled === true && before.kind === 'manual') {
      const { rows: [a] } = await c.query(`SELECT 1 FROM fiat_rail_accounts WHERE rail_id = $1 AND is_active`, [railId]);
      if (!a) throw new HttpError(409, 'El riel no tiene una cuenta activa: cargue y apruebe una cuenta antes de encenderlo', 'rail_without_account');
    }
    const { rows: [after] } = await c.query(
      `UPDATE fiat_rails SET is_enabled = $2, maintenance_message = $3, min_amount = $4, max_amount = $5, recommended_for = $6,
              settlement_time = $7, priority = $8, fallback_of = $9, visibility = $11, label = $12, currency = $13, country = $14,
              rail_type = $15, requires_review = $16, is_archived = $17,
              archived_at = CASE WHEN $17 THEN COALESCE(archived_at, now()) ELSE NULL END, updated_at = now(), updated_by = $10
        WHERE rail_id = $1 RETURNING ${RAIL_COLS}`,
      [railId, next.is_enabled, next.maintenance_message, next.min_amount, next.max_amount, next.recommended_for, next.settlement_time,
        next.priority, next.fallback_of, op.email, next.visibility, next.label, next.currency, next.country, next.rail_type,
        next.requires_review, next.is_archived]);
    let lastOff = false;
    if (before.is_enabled && !after.is_enabled) {
      const { rows: [o] } = await c.query(`SELECT count(*)::int AS n FROM fiat_rails WHERE currency = $1 AND is_enabled`, [after.currency]);
      lastOff = o.n === 0;
    }
    return { before, after, lastOff };
  });
  const pick = (r: Record<string, unknown>) => Object.fromEntries(Object.keys(r).filter((k) => !['updated_at', 'updated_by'].includes(k)).map((k) => [k, r[k]]));
  const changed = Object.keys(pick(out.after)).filter((k) => String(out.before[k] ?? '') !== String(out.after[k] ?? ''));
  const meta = (o: Record<string, unknown>) => Object.fromEntries(changed.map((k) => [k, o[k]]));
  const base = { reason, changed_fields: changed, before: meta(out.before), after: meta(out.after) };
  if (changed.includes('is_enabled') || !changed.length) {
    await audit({ operator_id: op.id, actor: op.email, action: 'fiat_rail_toggled', target: railId, status: 200, ip, metadata: base });
  }
  if (changed.some((k) => !['is_enabled', 'is_archived'].includes(k))) {
    await audit({ operator_id: op.id, actor: op.email, action: 'fiat_rail_updated', target: railId, status: 200, ip, metadata: base });
  }
  if (changed.includes('is_archived')) {
    await audit({ operator_id: op.id, actor: op.email, action: out.after.is_archived ? 'fiat_rail_archived' : 'fiat_rail_restored', target: railId, status: 200, ip, metadata: base });
  }
  if (out.lastOff) {
    await audit({
      operator_id: op.id, actor: op.email, action: 'fiat_rail_last_active_disabled', target: railId, status: 200, ip,
      metadata: { alert: true, currency: out.after.currency, reason },
    });
  }
}

/** Eliminación definitiva: solo rieles manuales archivados y sin historial. Borra propuestas pendientes y asignaciones. */
export async function deleteRail(op: Operator, railId: string, confirm: string, reason: string, ip?: string) {
  if (confirm !== railId) throw new HttpError(400, 'La confirmación debe ser el rail_id exacto', 'confirmation_mismatch');
  const label = await tx(async (c) => {
    const { rows: [r] } = await c.query('SELECT label, kind, is_archived FROM fiat_rails WHERE rail_id = $1 FOR UPDATE', [railId]);
    if (!r) throw new HttpError(404, 'Riel no encontrado', 'not_found');
    if (r.kind !== 'manual') throw new HttpError(409, 'Un riel automático no se elimina', 'rail_locked');
    if (!r.is_archived) throw new HttpError(409, 'Archive el riel antes de eliminarlo', 'rail_not_archived');
    const { rows: [h] } = await c.query('SELECT 1 FROM fiat_rail_accounts WHERE rail_id = $1 AND approved_by IS NOT NULL LIMIT 1', [railId]);
    const { rows: [f] } = await c.query('SELECT 1 FROM fiat_rails WHERE fallback_of = $1 LIMIT 1', [railId]);
    if (h || f) {
      throw new HttpError(409, h ? 'El riel tiene historial (cuentas aprobadas): solo puede archivarse, no eliminarse' : 'Otro riel lo usa como alterno: cambie ese alterno antes de eliminarlo', 'rail_has_history');
    }
    await c.query(`SELECT set_config('app.rail_delete', 'on', true)`);
    await c.query('DELETE FROM fiat_rail_accounts WHERE rail_id = $1', [railId]);
    await c.query('DELETE FROM fiat_rail_clients WHERE rail_id = $1', [railId]);
    await c.query('DELETE FROM fiat_rails WHERE rail_id = $1', [railId]);
    return r.label as string;
  });
  await audit({ operator_id: op.id, actor: op.email, action: 'fiat_rail_deleted', target: railId, status: 200, ip, metadata: { rail_id: railId, label, reason } });
  return { deleted: true, rail_id: railId };
}

export async function proposeAccount(op: Operator, railId: string, input: unknown, reason: string, ip?: string) {
  key();
  const { rows: [rail] } = await pool.query('SELECT rail_id, rail_type, kind FROM fiat_rails WHERE rail_id = $1', [railId]);
  if (!rail) throw new HttpError(404, 'Riel no encontrado', 'not_found');
  if (rail.kind !== 'manual') throw new HttpError(409, 'Los rieles automáticos no llevan cuenta cargada', 'rail_not_manual');
  const details = parseDetails(rail.rail_type, input);
  const res = await tx(async (c) => {
    await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`fiat_rail_account:${railId}`]);
    const { rows: [v] } = await c.query('SELECT COALESCE(max(version), 0) + 1 AS next FROM fiat_rail_accounts WHERE rail_id = $1', [railId]);
    const { rows: [act] } = await c.query('SELECT version, details_enc FROM fiat_rail_accounts WHERE rail_id = $1 AND is_active', [railId]);
    const prev = act ? decryptDetails(railId, act.version, act.details_enc) : {};
    const changed = Object.keys({ ...prev, ...details }).filter((k) => prev[k] !== details[k]).sort();
    if (!changed.length) throw new HttpError(409, 'La propuesta no cambia ningún campo de la cuenta activa', 'no_changes');
    await c.query(`UPDATE fiat_rail_accounts SET status = 'superseded', decision_reason = 'sustituida por una propuesta nueva'
                    WHERE rail_id = $1 AND status = 'proposed'`, [railId]);
    const { rows: [row] } = await c.query(
      `INSERT INTO fiat_rail_accounts (rail_id, version, details_enc, last4, changed_fields, proposal_reason, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING version, last4, changed_fields, status`,
      [railId, v.next, encryptDetails(railId, v.next, details), last4Of(details), changed, reason, op.email]);
    return row;
  });
  await audit({
    operator_id: op.id, actor: op.email, action: 'fiat_rail_account_proposed', target: railId, status: 201, ip,
    metadata: { version: res.version, changed_fields: res.changed_fields, last4: res.last4, reason },
  });
  return res;
}

export async function approveAccount(op: Operator, railId: string, version: number, reason: string, ip?: string) {
  key();
  const res = await tx(async (c) => {
    await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`fiat_rail_account:${railId}`]);
    const { rows: [p] } = await c.query('SELECT * FROM fiat_rail_accounts WHERE rail_id = $1 AND version = $2 FOR UPDATE', [railId, version]);
    if (!p) throw new HttpError(404, 'Propuesta no encontrada', 'not_found');
    if (p.status !== 'proposed') throw new HttpError(409, `La propuesta ya está ${p.status}`, 'proposal_not_pending');
    if (p.created_by === op.email) throw new HttpError(403, 'La cuenta debe aprobarla un tesorero distinto al que la propuso', 'forbidden');
    await c.query(`UPDATE fiat_rail_accounts SET status = 'superseded', is_active = false WHERE rail_id = $1 AND is_active`, [railId]);
    await c.query(`UPDATE fiat_rail_accounts SET status = 'active', is_active = true, approved_by = $3, approved_at = now(), decision_reason = $4
                    WHERE rail_id = $1 AND version = $2`, [railId, version, op.email, reason]);
    return { version, last4: p.last4, changed_fields: p.changed_fields as string[], proposed_by: p.created_by as string };
  });
  await audit({
    operator_id: op.id, actor: op.email, action: 'fiat_rail_account_approved', target: railId, status: 200, ip,
    metadata: { version: res.version, changed_fields: res.changed_fields, last4: res.last4, proposed_by: res.proposed_by, reason },
  });
  return { rail_id: railId, version: res.version, status: 'active', last4: res.last4 };
}

export async function rejectAccount(op: Operator, railId: string, version: number, reason: string, ip?: string) {
  const res = await tx(async (c) => {
    const { rows: [p] } = await c.query('SELECT status, last4, changed_fields FROM fiat_rail_accounts WHERE rail_id = $1 AND version = $2 FOR UPDATE', [railId, version]);
    if (!p) throw new HttpError(404, 'Propuesta no encontrada', 'not_found');
    if (p.status !== 'proposed') throw new HttpError(409, `La propuesta ya está ${p.status}`, 'proposal_not_pending');
    await c.query(`UPDATE fiat_rail_accounts SET status = 'rejected', decision_reason = $3, approved_by = $4, approved_at = now() WHERE rail_id = $1 AND version = $2`,
      [railId, version, reason, op.email]);
    return p;
  });
  await audit({
    operator_id: op.id, actor: op.email, action: 'fiat_rail_account_rejected', target: railId, status: 200, ip,
    metadata: { version, changed_fields: res.changed_fields, last4: res.last4, reason },
  });
  return { rail_id: railId, version, status: 'rejected' };
}

// ───────────── Portal ─────────────
export interface PortalRail {
  rail_id: string; label: string; currency: string; country: string | null; rail_type: string; kind: string;
  recommended_for: string | null; settlement_time: string | null; min_amount: string | null; max_amount: string | null;
  requires_review: boolean; memo: string | null; fields?: { key: string; label: string; value: string }[];
}

/** Lee siempre de la base (sin caché): apagar un riel lo oculta de inmediato. Nunca expone datos internos del riel. */
export async function activeRailsFor(clientId: string, amount?: string) {
  const { rows: [cl] } = await pool.query('SELECT counterparty_code FROM clients WHERE id = $1', [clientId]);
  const memo: string | null = cl?.counterparty_code ?? null;
  const { rows } = await pool.query(
    `SELECT r.rail_id, r.label, r.currency, r.country, r.rail_type, r.kind, r.is_enabled, r.priority, r.fallback_of, r.maintenance_message,
            r.min_amount::text AS min_amount, r.max_amount::text AS max_amount, r.recommended_for, r.settlement_time, r.requires_review,
            a.version, a.details_enc
       FROM fiat_rails r LEFT JOIN fiat_rail_accounts a ON a.rail_id = r.rail_id AND a.is_active
      WHERE NOT r.is_archived AND (r.visibility = 'all' OR EXISTS (SELECT 1 FROM fiat_rail_clients rc WHERE rc.rail_id = r.rail_id AND rc.client_id = $1))
      ORDER BY r.priority, r.rail_id`, [clientId]);
  const amt = amount != null && /^\d{1,15}(\.\d{1,2})?$/.test(amount) ? Number(amount) : null;
  const inRange = (r: { min_amount: string | null; max_amount: string | null }) =>
    amt == null || ((r.min_amount == null || amt >= Number(r.min_amount)) && (r.max_amount == null || amt <= Number(r.max_amount)));
  const usable = rows.filter((r) => r.is_enabled && (r.kind === 'automatic' || (r.details_enc && railsKeyConfigured())));
  const active_rails: PortalRail[] = usable.filter(inRange).map((r) => {
    const base: PortalRail = {
      rail_id: r.rail_id, label: r.label, currency: r.currency, country: r.country, rail_type: r.rail_type, kind: r.kind,
      recommended_for: r.recommended_for, settlement_time: r.settlement_time, min_amount: r.min_amount, max_amount: r.max_amount,
      requires_review: r.requires_review, memo,
    };
    if (r.kind === 'manual') {
      const d = decryptDetails(r.rail_id, r.version, r.details_enc);
      base.fields = Object.entries(d).map(([k, v]) => ({ key: k, label: LABELS[k] ?? k, value: v }));
    }
    return base;
  });
  const unavailable_rails = rows.filter((r) => !r.is_enabled && r.maintenance_message && (r.kind === 'automatic' || r.details_enc)).map((r) => {
    const alt = usable.find((u) => u.fallback_of === r.rail_id) ?? usable.find((u) => u.currency === r.currency);
    return {
      rail_id: r.rail_id, label: r.label, currency: r.currency, maintenance_message: r.maintenance_message,
      alternative: alt ? { rail_id: alt.rail_id, label: alt.label } : null,
    };
  });
  return { active_rails, unavailable_rails };
}

/** El riel automático ¿admite avisos de pago de este cliente? Apagado → rail_disabled; restringido y sin asignar → rail_not_available. */
export async function assertIntentRailOpen(railId: string, clientId: string) {
  const { rows: [r] } = await pool.query(
    `SELECT is_enabled, maintenance_message, visibility,
            EXISTS (SELECT 1 FROM fiat_rail_clients rc WHERE rc.rail_id = $1 AND rc.client_id = $2) AS assigned
       FROM fiat_rails WHERE rail_id = $1`, [railId, clientId]);
  if (!r) return; // despliegues previos a 024
  if (r.visibility === 'restricted' && !r.assigned) throw new HttpError(409, 'Este riel no está disponible para su empresa', 'rail_not_available');
  if (!r.is_enabled) throw new HttpError(409, r.maintenance_message || 'Este riel está temporalmente fuera de servicio', 'rail_disabled');
}
export async function railState(railId: string, clientId: string) {
  const { rows: [r] } = await pool.query(
    `SELECT is_enabled, maintenance_message,
            (visibility = 'all' OR EXISTS (SELECT 1 FROM fiat_rail_clients rc WHERE rc.rail_id = r.rail_id AND rc.client_id = $2)) AS visible
       FROM fiat_rails r WHERE rail_id = $1`, [railId, clientId]);
  return r ? { rail_id: railId, enabled: r.is_enabled as boolean, maintenance_message: (r.maintenance_message as string | null) ?? null, visible: r.visible as boolean } : null;
}

// ───────────── Asignación de rieles a clientes ─────────────
export async function listRailClients(railId: string) {
  const { rows: [r] } = await pool.query('SELECT visibility FROM fiat_rails WHERE rail_id = $1', [railId]);
  if (!r) throw new HttpError(404, 'Riel no encontrado', 'not_found');
  const { rows } = await pool.query(
    `SELECT rc.client_id, c.name AS client_name, c.counterparty_code, rc.assigned_by, rc.created_at
       FROM fiat_rail_clients rc JOIN clients c ON c.id = rc.client_id WHERE rc.rail_id = $1 ORDER BY c.name`, [railId]);
  return { rail_id: railId, visibility: r.visibility as string, clients: rows };
}

export async function listClientRails(clientId: string) {
  const { rows } = await pool.query(
    `SELECT r.rail_id, r.label, r.currency, r.kind, r.is_enabled, r.visibility,
            EXISTS (SELECT 1 FROM fiat_rail_clients rc WHERE rc.rail_id = r.rail_id AND rc.client_id = $1) AS assigned
       FROM fiat_rails r WHERE NOT r.is_archived ORDER BY r.currency, r.priority, r.rail_id`, [clientId]);
  return { client_id: clientId, rails: rows.map((r) => ({ ...r, effective: r.visibility === 'all' || r.assigned })) };
}

export async function assignRailClient(op: Operator, railId: string, clientId: string, assign: boolean, reason: string, ip?: string) {
  await tx(async (c) => {
    const { rows: [r] } = await c.query('SELECT 1 FROM fiat_rails WHERE rail_id = $1 FOR UPDATE', [railId]);
    if (!r) throw new HttpError(404, 'Riel no encontrado', 'not_found');
    const { rows: [cl] } = await c.query('SELECT 1 FROM clients WHERE id = $1', [clientId]);
    if (!cl) throw new HttpError(404, 'Cliente no encontrado', 'not_found');
    if (assign) {
      const { rowCount } = await c.query('INSERT INTO fiat_rail_clients (rail_id, client_id, assigned_by) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING', [railId, clientId, op.email]);
      if (!rowCount) throw new HttpError(409, 'El cliente ya está asignado a este riel', 'already_assigned');
    } else {
      const { rowCount } = await c.query('DELETE FROM fiat_rail_clients WHERE rail_id = $1 AND client_id = $2', [railId, clientId]);
      if (!rowCount) throw new HttpError(404, 'El cliente no estaba asignado a este riel', 'not_found');
    }
  });
  await audit({
    operator_id: op.id, actor: op.email, action: assign ? 'fiat_rail_client_assigned' : 'fiat_rail_client_unassigned', target: railId,
    status: 200, ip, client_id: clientId, metadata: { rail_id: railId, reason },
  });
  return { rail_id: railId, client_id: clientId, assigned: assign };
}

