// Portal de clientes — fase 4: obligaciones y compensación.
// El ACREEDOR registra (usuario operator+ o llave Ed25519 con permiso trade); el DEUDOR acepta o rechaza con motivo.
// Solo las aceptadas (open) entran a compensación. Cada cliente ve únicamente las obligaciones donde es parte y,
// de su contraparte directa, solo el nombre. Lo ajeno responde 404. Ver migración 014.
import { config } from '../config.js';
import { pool, tx, type Tx } from '../db.js';
import { HttpError } from '../idempotency.js';
import { decodeCursor, page } from '../pagination.js';
import { previewNetting } from '../ledger/netting.js';
import { consumeTotp, roleAtLeast, type PortalPrincipal } from './identity.js';
import { assertAssetEnabled, assetStatus } from '../ledger/client-assets.js';

const NOT_FOUND = (what: string) => new HttpError(404, `${what} no encontrada`, 'not_found');
const CODE_RE = /^856-[23456789ABCDEFGHJKMNPQRSTVWXYZ]{4}-[23456789ABCDEFGHJKMNPQRSTVWXYZ]{4}$/;
export const normalizeCode = (c: string) => c.trim().toUpperCase().replace(/\s+/g, '');

type Origin = { kind: 'client_user' | 'client_key'; ref: string; actor: string };
/** Quién origina: usuario operator+ o llave Ed25519 con permiso trade (las llaves de lectura nunca). */
export function tradeOrigin(p: PortalPrincipal): Origin {
  if (p.kind === 'client_user') {
    if (!roleAtLeast(p.user.role, 'operator')) throw new HttpError(403, 'Requiere rol operator', 'forbidden');
    return { kind: 'client_user', ref: p.user.id, actor: `portal:${p.user.email}` };
  }
  if (p.kind === 'assist') throw new HttpError(403, 'La sesión de asistencia es de solo lectura', 'operation_not_allowed_in_assist_mode');
  if (p.key.kind !== 'ed25519' || !p.key.permissions.includes('trade')) throw new HttpError(403, 'La llave no tiene permiso trade', 'forbidden');
  return { kind: 'client_key', ref: p.key.prefix, actor: `llave:${p.key.prefix}` };
}

/** Vence las aceptaciones fuera de plazo. La llaman el worker y cada lectura o decisión del portal. */
export async function expirePending(c: Tx | typeof pool = pool) {
  const { rowCount } = await c.query(
    `UPDATE obligations SET status = 'expired' WHERE status = 'pending_acceptance' AND accept_due_at <= now()`);
  return rowCount ?? 0;
}

// ═════════════ Contrapartes ═════════════
export async function myCounterpartyCode(clientId: string) {
  const { rows: [c] } = await pool.query('SELECT counterparty_code, name FROM clients WHERE id = $1', [clientId]);
  return { counterparty_code: c.counterparty_code as string, name: c.name as string };
}

async function counterpartyByCode(c: Tx | typeof pool, me: string, code: string) {
  const norm = normalizeCode(code);
  if (!CODE_RE.test(norm)) throw new HttpError(404, 'Código de contraparte no encontrado', 'counterparty_not_found');
  const { rows: [cp] } = await c.query('SELECT id, name, status, counterparty_code FROM clients WHERE counterparty_code = $1', [norm]);
  if (!cp || cp.id === me) throw new HttpError(404, 'Código de contraparte no encontrado', 'counterparty_not_found');
  return cp as { id: string; name: string; status: string; counterparty_code: string };
}

/** Confirmación del nombre antes de registrar: solo con el código exacto (no hay búsqueda ni lista). */
export async function lookupCounterparty(me: string, code: string) {
  const cp = await counterpartyByCode(pool, me, code);
  if (cp.status === 'closed') throw new HttpError(409, 'La contraparte está cerrada: no admite obligaciones', 'counterparty_closed');
  return { counterparty_code: cp.counterparty_code, name: cp.name };
}

// ═════════════ Vista ═════════════
const COLS = `o.id, o.debtor_id, o.creditor_id, o.asset_id, s.symbol, s.decimals, o.amount::text AS amount, o.external_ref, o.due_at,
  o.status, o.accept_due_at, o.accepted_at, o.rejected_at, o.rejected_reason, o.cancel_reason, o.cancelled_at,
  o.netting_run_id, o.settled_at, o.origin_kind, o.origin_ref, o.import_id, o.created_at, o.created_at::text AS _ts,
  d.name AS debtor_name, c.name AS creditor_name,
  (SELECT u.name FROM client_users u WHERE u.id::text = o.origin_ref AND o.origin_kind = 'client_user') AS origin_user,
  EXISTS (SELECT 1 FROM netting_runs r WHERE r.status = 'pending_approval' AND r.scope->'obligation_ids' ? o.id::text) AS in_pending_run`;
const FROM = `FROM obligations o JOIN assets s ON s.id = o.asset_id JOIN clients d ON d.id = o.debtor_id JOIN clients c ON c.id = o.creditor_id`;

function view(o: Record<string, unknown>, me: string) {
  const creditor = o.creditor_id === me;
  return {
    id: o.id, role: creditor ? 'creditor' : 'debtor',
    counterparty: { name: creditor ? o.debtor_name : o.creditor_name },
    asset_id: o.asset_id, symbol: o.symbol, decimals: o.decimals, amount: o.amount, external_ref: o.external_ref, due_at: o.due_at,
    status: o.status, accept_due_at: o.accept_due_at, accepted_at: o.accepted_at,
    rejected_at: o.rejected_at, rejected_reason: o.rejected_reason, cancelled_at: o.cancelled_at, cancel_reason: o.cancel_reason,
    netting_run_id: o.netting_run_id, settled_at: o.settled_at, in_pending_run: o.in_pending_run,
    // El origen solo se detalla a quien lo registró (es su propio usuario o llave)
    origin: creditor ? { kind: o.origin_kind, user: o.origin_user ?? null, key: o.origin_kind === 'client_key' ? o.origin_ref : null } : null,
    import_id: creditor ? o.import_id : null, created_at: o.created_at,
  };
}

export async function getObligation(me: string, id: string, allowExpiry = true) {
  if (allowExpiry) await expirePending();
  const { rows: [o] } = await pool.query(`SELECT ${COLS} ${FROM} WHERE o.id = $1 AND (o.debtor_id = $2 OR o.creditor_id = $2)`, [id, me]);
  if (!o) throw NOT_FOUND('Obligación');
  return view(o, me);
}

export async function listObligations(me: string, f: { role?: 'creditor' | 'debtor'; status?: string; asset_id?: string; limit: number; cursor?: string }, allowExpiry = true) {
  if (allowExpiry) await expirePending();
  const cur = decodeCursor(f.cursor);
  const { rows } = await pool.query(
    `SELECT ${COLS} ${FROM}
      WHERE (CASE $2::text WHEN 'creditor' THEN o.creditor_id = $1 WHEN 'debtor' THEN o.debtor_id = $1 ELSE (o.debtor_id = $1 OR o.creditor_id = $1) END)
        AND ($3::text IS NULL OR o.status = $3) AND ($4::text IS NULL OR o.asset_id = $4)
        AND ($5::timestamptz IS NULL OR (o.created_at, o.id) < ($5::timestamptz, $6::uuid))
      ORDER BY o.created_at DESC, o.id DESC LIMIT $7`,
    [me, f.role ?? null, f.status ?? null, f.asset_id ?? null, cur?.[0] ?? null, cur?.[1] ?? null, f.limit + 1]);
  const p = page(rows, f.limit);
  const { rows: [n] } = await pool.query(
    `SELECT count(*)::int AS n FROM obligations WHERE debtor_id = $1 AND status = 'pending_acceptance'`, [me]);
  return { obligations: p.items.map((o) => view(o, me)), next_cursor: p.next_cursor, to_accept: n.n };
}

// ═════════════ Alta (acreedor) ═════════════
export interface NewObligation { counterparty_code: string; asset_id: string; amount: string; external_ref?: string; due_at?: string }

async function assertCanRegister(c: Tx | typeof pool, me: string) {
  const { rows: [cl] } = await c.query('SELECT status FROM clients WHERE id = $1', [me]);
  if (cl?.status !== 'active') throw new HttpError(422, 'Su cuenta no está activa: no puede registrar obligaciones', 'client_not_active');
}

/** Inserta una obligación pendiente de aceptación. Devuelve el id; las validaciones de negocio lanzan HttpError. */
async function insertObligation(c: Tx, me: string, b: NewObligation, origin: Origin, ip: string | null, importId: string | null) {
  const cp = await counterpartyByCode(c, me, b.counterparty_code);
  if (cp.status === 'closed') throw new HttpError(409, 'La contraparte está cerrada: no admite obligaciones', 'counterparty_closed');
  const { rows: [a] } = await c.query('SELECT id FROM assets WHERE id = $1 AND active', [b.asset_id]);
  if (!a) throw new HttpError(422, `Activo no disponible: ${b.asset_id}`, 'asset_not_found');
  // Multi-red: el acreedor debe poder recibir el activo; el deudor, disponer de él
  await assertAssetEnabled(c, me, b.asset_id, 'in');
  const ds = await assetStatus(c, cp.id, b.asset_id);
  if (!ds) throw new HttpError(422, `Su contraparte no tiene habilitado ${b.asset_id}`, 'counterparty_asset_not_enabled');
  if (b.external_ref) {
    const { rows: [dup] } = await c.query(
      `SELECT id FROM obligations WHERE creditor_id = $1 AND debtor_id = $2 AND asset_id = $3 AND external_ref = $4
          AND status IN ('pending_acceptance','open') LIMIT 1`, [me, cp.id, b.asset_id, b.external_ref]);
    if (dup) throw new HttpError(409, `Ya existe una obligación pendiente o abierta con la referencia ${b.external_ref} para esa contraparte`, 'duplicate_obligation');
  }
  const { rows: [o] } = await c.query(
    `INSERT INTO obligations (debtor_id, creditor_id, asset_id, amount, due_at, external_ref, status, accept_due_at,
                              origin_kind, origin_ref, origin_ip, created_by, import_id)
     VALUES ($1,$2,$3,$4,$5,$6,'pending_acceptance', now() + make_interval(secs => $7), $8,$9,$10,$11,$12) RETURNING id`,
    [cp.id, me, b.asset_id, b.amount, b.due_at ?? null, b.external_ref ?? null, Math.round(config.OBLIGATION_ACCEPT_TTL_HOURS * 3600),
      origin.kind, origin.ref, ip, origin.actor, importId]);
  return o.id as string;
}

export async function createObligation(p: PortalPrincipal, b: NewObligation, ip: string) {
  const origin = tradeOrigin(p);
  await assertCanRegister(pool, p.clientId);
  const id = await tx((c) => insertObligation(c, p.clientId, b, origin, ip, null));
  return getObligation(p.clientId, id);
}

// ═════════════ Decisión del deudor ═════════════
async function lockAsDebtor(c: Tx, me: string, id: string) {
  await expirePending(c);
  const { rows: [o] } = await c.query('SELECT * FROM obligations WHERE id = $1 AND (debtor_id = $2 OR creditor_id = $2) FOR UPDATE', [id, me]);
  if (!o) throw NOT_FOUND('Obligación');
  if (o.debtor_id !== me) throw new HttpError(403, 'Solo el deudor acepta o rechaza la obligación', 'not_debtor');
  if (o.status === 'expired') throw new HttpError(409, 'Venció el plazo para aceptar: pida al acreedor que la registre de nuevo', 'expired');
  if (o.status !== 'pending_acceptance') throw new HttpError(409, `La obligación no está pendiente de aceptación (estado: ${o.status})`, 'not_pending');
  return o;
}

/**
 * Aceptar: operator+ o llave con trade. Si el monto alcanza el umbral de aprobación interna del deudor (fase 3),
 * solo un usuario approver+ con código 2FA puede aceptarla.
 */
export async function acceptObligation(p: PortalPrincipal, id: string, code?: string) {
  const origin = tradeOrigin(p);
  await tx(async (c) => {
    const o = await lockAsDebtor(c, p.clientId, id);
    await assertAssetEnabled(c, p.clientId, o.asset_id, 'out');
    const { rows: [t] } = await c.query(
      'SELECT threshold FROM client_approval_thresholds WHERE client_id = $1 AND asset_id = $2', [p.clientId, o.asset_id]);
    if (t && BigInt(o.amount) >= BigInt(t.threshold)) {
      if (p.kind !== 'client_user' || !roleAtLeast(p.user.role, 'approver')) {
        throw new HttpError(403, 'El monto alcanza su umbral de aprobación interna: debe aceptarla un Aprobador o Administrador con 2FA', 'approval_required');
      }
      if (!code || !(await consumeTotp(p.user.id, code))) throw new HttpError(422, 'Confirme con un código 2FA vigente', 'bad_code');
    }
    await c.query(`UPDATE obligations SET status = 'open', accepted_by = $2, accepted_at = now() WHERE id = $1`, [id, origin.actor]);
  });
  return getObligation(p.clientId, id);
}

export async function rejectObligation(p: PortalPrincipal, id: string, reason: string) {
  const origin = tradeOrigin(p);
  await tx(async (c) => {
    await lockAsDebtor(c, p.clientId, id);
    await c.query(
      `UPDATE obligations SET status = 'rejected', rejected_by = $2, rejected_at = now(), rejected_reason = $3 WHERE id = $1`,
      [id, origin.actor, reason.trim()]);
  });
  return getObligation(p.clientId, id);
}

/** Cancelar (acreedor): mientras esté pendiente, o abierta y fuera de una corrida en curso. */
export async function cancelObligation(p: PortalPrincipal, id: string, reason: string) {
  const origin = tradeOrigin(p);
  await tx(async (c) => {
    await expirePending(c);
    const { rows: [o] } = await c.query('SELECT * FROM obligations WHERE id = $1 AND (debtor_id = $2 OR creditor_id = $2) FOR UPDATE', [id, p.clientId]);
    if (!o) throw NOT_FOUND('Obligación');
    if (o.creditor_id !== p.clientId) throw new HttpError(403, 'Solo el acreedor cancela la obligación; como deudor puede rechazarla', 'not_creditor');
    if (!['pending_acceptance', 'open'].includes(o.status)) throw new HttpError(409, `La obligación ya no se puede cancelar (estado: ${o.status})`, 'not_cancellable');
    const { rows: [run] } = await c.query(
      `SELECT id FROM netting_runs WHERE status = 'pending_approval' AND scope->'obligation_ids' ? $1::text LIMIT 1`, [id]);
    if (run) throw new HttpError(409, 'La obligación está en una corrida de compensación en curso: no se puede cancelar', 'in_pending_run');
    await c.query(
      `UPDATE obligations SET status = 'cancelled', cancel_reason = $2, cancelled_at = now(), cancelled_by = $3 WHERE id = $1`,
      [id, reason.trim(), origin.actor]);
  });
  return getObligation(p.clientId, id);
}

// ═════════════ Carga masiva (CSV) ═════════════
/** CSV mínimo: separador coma o punto y coma (se detecta en el encabezado), comillas dobles y BOM de Excel. */
export function parseCsv(text: string): string[][] {
  const src = text.replace(/^﻿/, '');
  const firstLine = src.split(/\r?\n/, 1)[0] ?? '';
  const sep = (firstLine.match(/;/g)?.length ?? 0) > (firstLine.match(/,/g)?.length ?? 0) ? ';' : ',';
  const rows: string[][] = [];
  let row: string[] = [], cell = '', q = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (q) {
      if (ch === '"') { if (src[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += ch;
    } else if (ch === '"') q = true;
    else if (ch === sep) { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++;
      row.push(cell); rows.push(row); row = []; cell = '';
    } else cell += ch;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows.filter((r) => r.some((c) => c.trim() !== ''));
}

/** Monto en unidades del activo (punto decimal, sin separadores de miles) → unidades base, sin float. */
export function toBaseUnits(text: string, decimals: number): string | null {
  const t = text.trim();
  if (!/^\d+(\.\d+)?$/.test(t)) return null;
  const [i, f = ''] = t.split('.');
  if (f.length > decimals) return null;
  const v = BigInt(i + f.padEnd(decimals, '0'));
  return v > 0n ? v.toString() : null;
}

const COLUMNS = ['contraparte', 'activo', 'monto', 'referencia', 'vencimiento'] as const;
type RowError = { row: number; field: string; message: string };
type ImportValidationResult = {
  id: string | null; filename: string | null; status: string; total_rows: number; valid_rows: number; error_rows: number;
  errors: RowError[];
  preview: { row: number; counterparty: string; asset_id: string; amount: string; external_ref: string | null; due_at: string | null }[];
  created_at: Date | null; decided_at: Date | null;
};

export async function validateImport(
  p: PortalPrincipal, filename: string | undefined, csv: string, c: Tx | typeof pool = pool, persist = true,
): Promise<ImportValidationResult> {
  const origin = tradeOrigin(p);
  await assertCanRegister(c, p.clientId);
  const table = parseCsv(csv);
  if (!table.length) throw new HttpError(422, 'El archivo está vacío', 'empty_file');
  const header = table[0].map((h) => h.trim().toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, ''));
  const idx = Object.fromEntries(COLUMNS.map((c) => [c, header.indexOf(c)])) as Record<(typeof COLUMNS)[number], number>;
  const missing = (['contraparte', 'activo', 'monto'] as const).filter((c) => idx[c] < 0);
  if (missing.length) throw new HttpError(422, `Faltan columnas obligatorias: ${missing.join(', ')} (encabezados: ${COLUMNS.join(', ')})`, 'bad_header');
  const data = table.slice(1);
  if (data.length > config.OBLIGATION_IMPORT_MAX_ROWS) {
    throw new HttpError(422, `Máximo ${config.OBLIGATION_IMPORT_MAX_ROWS} filas por archivo (trae ${data.length}): divídalo`, 'too_many_rows');
  }
  const { rows: assets } = await c.query<{ id: string; symbol: string; decimals: number }>('SELECT id, symbol, decimals FROM assets WHERE active');
  const assetById = new Map(assets.map((a) => [a.id, a]));
  const codes = [...new Set(data.map((r) => normalizeCode(r[idx.contraparte] ?? '')).filter((c) => CODE_RE.test(c)))];
  const { rows: cps } = await c.query<{ id: string; status: string; counterparty_code: string; name: string }>(
    'SELECT id, status, counterparty_code, name FROM clients WHERE counterparty_code = ANY($1)', [codes]);
  const cpByCode = new Map(cps.filter((c) => c.id !== p.clientId).map((c) => [c.counterparty_code, c]));
  const { rows: existing } = await c.query<{ debtor_id: string; asset_id: string; external_ref: string }>(
    `SELECT debtor_id, asset_id, external_ref FROM obligations
      WHERE creditor_id = $1 AND external_ref IS NOT NULL AND status IN ('pending_acceptance','open')`, [p.clientId]);
  const seen = new Set(existing.map((e) => `${e.debtor_id}|${e.asset_id}|${e.external_ref}`));
  // Multi-red: activos habilitados del acreedor (recibir) y de las contrapartes (cualquier estado)
  const { rows: en } = await c.query<{ client_id: string; asset_id: string; status: string }>(
    'SELECT client_id, asset_id, status FROM client_assets WHERE client_id = ANY($1)', [[p.clientId, ...cps.map((x) => x.id)]]);
  const enabled = new Map(en.map((e) => [`${e.client_id}|${e.asset_id}`, e.status]));

  const errors: RowError[] = [];
  const valid: (NewObligation & { row: number; counterparty_name: string })[] = [];
  data.forEach((r, i) => {
    const row = i + 2; // número de fila como lo ve el usuario en su hoja (1 = encabezado)
    const err = (field: string, message: string) => errors.push({ row, field, message });
    const before = errors.length;
    const code = normalizeCode(r[idx.contraparte] ?? '');
    const cp = cpByCode.get(code);
    if (!cp) err('contraparte', 'Código de contraparte no encontrado');
    else if (cp.status === 'closed') err('contraparte', 'Contraparte cerrada');
    const assetId = (r[idx.activo] ?? '').trim().toUpperCase();
    const asset = assetById.get(assetId);
    if (!asset) err('activo', `Activo no disponible: ${assetId || '(vacío)'}`);
    else {
      const symbol = asset.symbol.toUpperCase();
      const expected = symbol === 'USDC' ? 6 : ['EURE', 'ETH'].includes(symbol) ? 18 : null;
      if (expected !== null && asset.decimals !== expected) err('activo', `${symbol} debe tener ${expected} decimales`);
    }
    const amount = asset ? toBaseUnits(r[idx.monto] ?? '', asset.decimals) : null;
    if (asset && enabled.get(`${p.clientId}|${asset.id}`) !== 'enabled') err('activo', `No tiene habilitado ${asset.id} para recibir`);
    else if (asset && cp && !enabled.has(`${cp.id}|${asset.id}`)) err('activo', `La contraparte no tiene habilitado ${asset.id}`);
    if (asset && !amount) err('monto', `Monto inválido: use punto decimal, sin separadores de miles y hasta ${asset.decimals} decimales`);
    const ref = idx.referencia >= 0 ? (r[idx.referencia] ?? '').trim() : '';
    if (ref.length > 200) err('referencia', 'Máximo 200 caracteres');
    let due: string | undefined;
    const dueText = idx.vencimiento >= 0 ? (r[idx.vencimiento] ?? '').trim() : '';
    if (dueText) {
      const d = new Date(/^\d{4}-\d{2}-\d{2}$/.test(dueText) ? `${dueText}T00:00:00Z` : dueText);
      if (Number.isNaN(d.getTime())) err('vencimiento', 'Fecha inválida: use AAAA-MM-DD');
      else due = d.toISOString();
    }
    if (cp && asset && ref) {
      const k = `${cp.id}|${asset.id}|${ref}`;
      if (seen.has(k)) err('referencia', `Duplicada: ya hay una obligación pendiente o abierta (o una fila anterior) con la referencia ${ref} para esa contraparte`);
      else seen.add(k);
    }
    if (errors.length === before && cp && asset && amount) {
      valid.push({ row, counterparty_code: code, counterparty_name: cp.name, asset_id: asset.id, amount, external_ref: ref || undefined, due_at: due });
    }
  });
  if (!persist) {
    return {
      id: null, filename: filename?.slice(0, 200) ?? null, status: 'simulated', total_rows: data.length,
      valid_rows: valid.length, error_rows: new Set(errors.map((e) => e.row)).size, errors,
      preview: valid.slice(0, 20).map((r) => ({
        row: r.row, counterparty: r.counterparty_name, asset_id: r.asset_id, amount: r.amount,
        external_ref: r.external_ref ?? null, due_at: r.due_at ?? null,
      })),
      created_at: null, decided_at: null,
    };
  }
  const { rows: [imp] } = await c.query(
    `INSERT INTO obligation_imports (client_id, filename, total_rows, valid_rows, rows, errors, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
    [p.clientId, filename?.slice(0, 200) ?? null, data.length, valid.length, JSON.stringify(valid), JSON.stringify(errors), origin.actor]);
  return importView(imp);
}

const importView = (i: Record<string, unknown>): ImportValidationResult => {
  const rows = i.rows as (NewObligation & { row: number; counterparty_name: string })[];
  return {
    id: i.id as string, filename: i.filename as string | null, status: i.status as string, total_rows: i.total_rows as number,
    valid_rows: i.valid_rows as number, error_rows: new Set((i.errors as RowError[]).map((e) => e.row)).size,
    errors: i.errors as RowError[],
    preview: rows.slice(0, 20).map((r) => ({
      row: r.row, counterparty: r.counterparty_name, asset_id: r.asset_id, amount: r.amount,
      external_ref: r.external_ref ?? null, due_at: r.due_at ?? null,
    })),
    created_at: i.created_at as Date, decided_at: i.decided_at as Date | null,
  };
};

async function lockImport(c: Tx, me: string, id: string) {
  const { rows: [i] } = await c.query('SELECT * FROM obligation_imports WHERE id = $1 AND client_id = $2 FOR UPDATE', [id, me]);
  if (!i) throw NOT_FOUND('Carga');
  if (i.status !== 'validated') throw new HttpError(409, `La carga ya fue ${i.status === 'committed' ? 'confirmada' : 'descartada'}`, 'import_closed');
  return i;
}

/** Confirma TODAS las filas válidas en una sola transacción: si alguna ya no procede, no se registra ninguna. */
export async function commitImport(p: PortalPrincipal, id: string, ip: string) {
  const origin = tradeOrigin(p);
  await assertCanRegister(pool, p.clientId);
  const created = await tx(async (c) => {
    const i = await lockImport(c, p.clientId, id);
    const rows = i.rows as (NewObligation & { row: number })[];
    if (!rows.length) throw new HttpError(422, 'La carga no tiene filas válidas', 'nothing_to_import');
    for (const r of rows) {
      try {
        await insertObligation(c, p.clientId, r, origin, ip, id);
      } catch (e) {
        if (e instanceof HttpError) throw new HttpError(409, `Fila ${r.row}: ${e.message}. No se registró ninguna; valide el archivo de nuevo`, 'import_row_failed');
        throw e;
      }
    }
    await c.query(`UPDATE obligation_imports SET status = 'committed', decided_at = now() WHERE id = $1`, [id]);
    return rows.length;
  });
  const { rows: [i] } = await pool.query('SELECT * FROM obligation_imports WHERE id = $1', [id]);
  return { ...importView(i), created };
}

export async function discardImport(p: PortalPrincipal, id: string) {
  tradeOrigin(p);
  await tx(async (c) => {
    await lockImport(c, p.clientId, id);
    await c.query(`UPDATE obligation_imports SET status = 'discarded', decided_at = now() WHERE id = $1`, [id]);
  });
  const { rows: [i] } = await pool.query('SELECT * FROM obligation_imports WHERE id = $1', [id]);
  return importView(i);
}

// ═════════════ Compensación (vista del cliente) ═════════════
/**
 * Posición en la próxima corrida: se simula sobre todas las obligaciones abiertas del activo (como la consola),
 * pero solo se devuelve lo propio. El ahorro estimado es lo que el cliente deja de mover: bruto propio − |neto|.
 */
export async function myPositions(me: string, assetId?: string) {
  const { rows: assets } = await pool.query<{ id: string; symbol: string; decimals: number }>(
    `SELECT id, symbol, decimals FROM assets WHERE active AND ($1::text IS NULL OR id = $1) ORDER BY id`, [assetId ?? null]);
  if (assetId && !assets.length) throw NOT_FOUND('Activo');
  const out = [];
  for (const a of assets) {
    const pv = await previewNetting({ asset_id: a.id });
    const mine = pv.positions.find((x) => x.client_id === me);
    if (!mine && assetId === undefined) continue;
    const receivable = BigInt(mine?.receivable ?? '0'), payable = BigInt(mine?.payable ?? '0'), net = BigInt(mine?.net ?? '0');
    const gross = receivable + payable, moved = net < 0n ? -net : net;
    const { rows: [n] } = await pool.query(
      `SELECT count(*)::int AS n FROM obligations WHERE status = 'open' AND asset_id = $2 AND (debtor_id = $1 OR creditor_id = $1)`, [me, a.id]);
    out.push({
      asset_id: a.id, symbol: a.symbol, decimals: a.decimals, open_obligations: n.n,
      receivable: receivable.toString(), payable: payable.toString(), net: net.toString(),
      gross: gross.toString(), savings: (gross - moved).toString(),
      savings_bps: gross > 0n ? Number(((gross - moved) * 10000n) / gross) : 0,
      available: mine?.available ?? null, shortfall: mine?.shortfall ?? '0',
    });
  }
  return { positions: out };
}

export async function myRuns(me: string, f: { asset_id?: string; limit: number; cursor?: string }) {
  const cur = decodeCursor(f.cursor);
  const { rows } = await pool.query(
    `SELECT r.id, r.asset_id, s.symbol, s.decimals, r.decided_at, r.created_at, r.created_at::text AS _ts,
            p.receivable::text AS receivable, p.payable::text AS payable, p.net::text AS net
       FROM netting_positions p JOIN netting_runs r ON r.id = p.run_id JOIN assets s ON s.id = r.asset_id
      WHERE p.client_id = $1 AND r.status = 'settled' AND ($2::text IS NULL OR r.asset_id = $2)
        AND ($3::timestamptz IS NULL OR (r.created_at, r.id) < ($3::timestamptz, $4::uuid))
      ORDER BY r.created_at DESC, r.id DESC LIMIT $5`,
    [me, f.asset_id ?? null, cur?.[0] ?? null, cur?.[1] ?? null, f.limit + 1]);
  const p = page(rows, f.limit);
  return { runs: p.items.map(({ _ts, ...r }) => r), next_cursor: p.next_cursor };
}

/** Detalle de una corrida donde participó: su posición, sus obligaciones liquidadas y su renglón del asiento. */
export async function myRun(me: string, id: string) {
  const { rows: [r] } = await pool.query(
    `SELECT r.id, r.asset_id, s.symbol, s.decimals, r.entry_id, r.decided_at, r.created_at,
            p.receivable::text AS receivable, p.payable::text AS payable, p.net::text AS net
       FROM netting_positions p JOIN netting_runs r ON r.id = p.run_id JOIN assets s ON s.id = r.asset_id
      WHERE r.id = $1 AND p.client_id = $2 AND r.status = 'settled'`, [id, me]);
  if (!r) throw NOT_FOUND('Corrida');
  const { rows: obligations } = await pool.query(
    `SELECT ${COLS} ${FROM} WHERE o.netting_run_id = $1 AND (o.debtor_id = $2 OR o.creditor_id = $2) ORDER BY o.created_at`, [id, me]);
  const { rows: [line] } = r.entry_id ? await pool.query(
    `SELECT p.direction, p.amount::text AS amount, p.balance_after::text AS balance_after, p.created_at
       FROM postings p JOIN accounts a ON a.id = p.account_id WHERE p.entry_id = $1 AND a.client_id = $2`, [r.entry_id, me]) : { rows: [] };
  const { entry_id, ...rest } = r;
  return {
    ...rest, entry: line ? { id: entry_id, ...line, kind: line.direction === 'credit' ? 'abono' : 'cargo' } : null,
    obligations: obligations.map((o) => view(o, me)),
  };
}

/** Avisos del portal (fase 4): obligaciones por aceptar, con las que vencen en menos de 24 h. */
export async function obligationNotices(me: string, allowExpiry = true) {
  if (allowExpiry) await expirePending();
  const { rows: [n] } = await pool.query(
    `SELECT count(*)::int AS total, count(*) FILTER (WHERE accept_due_at <= now() + interval '24 hours')::int AS soon
       FROM obligations WHERE debtor_id = $1 AND status = 'pending_acceptance'`, [me]);
  if (!n.total) return [];
  return [{
    code: 'obligations_to_accept', severity: n.soon ? 'warning' as const : 'info' as const,
    message: `Tiene ${n.total} obligación(es) por aceptar o rechazar${n.soon ? `; ${n.soon} vence(n) en menos de 24 h` : ''}`,
    data: { total: n.total, expiring_24h: n.soon },
  }];
}
