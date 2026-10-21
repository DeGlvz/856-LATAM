// Configuración de cliente preparada por un ejecutivo y liberada por un tesorero.
// Ciclo: draft → submitted (envío a tesorería) → released (se aplica) | rejected | cancelled.
// Quien libera no puede ser quien preparó el borrador; el 2FA del tesorero se verifica en la ruta.
import { isAddress } from 'viem';
import { net, primaryNet } from '../chain/networks.js';
import { config } from '../config.js';
import { pool, tx, type Tx } from '../db.js';
import { HttpError } from '../idempotency.js';
import type { Operator } from '../auth/operators.js';

export type DraftPayload =
  | { kind: 'whitelist'; address: string; network?: string; label?: string }
  | { kind: 'threshold'; asset_id: string; threshold: string | null };

const NOT_FOUND = () => new HttpError(404, 'Borrador no encontrado', 'not_found');
const conflict = (m: string, code: string) => new HttpError(409, m, code);

const view = (d: Record<string, unknown>) => ({
  id: d.id, client_id: d.client_id, kind: d.kind, payload: d.payload, status: d.status,
  created_by: d.created_by_email, created_at: d.created_at, submitted_at: d.submitted_at,
  decided_by: d.decided_by_email, decided_at: d.decided_at, decision_note: d.decision_note, applied_ref: d.applied_ref,
});

export async function listDrafts(f: { clientId?: string; status?: string }) {
  const { rows } = await pool.query(
    `SELECT * FROM client_config_drafts
      WHERE ($1::uuid IS NULL OR client_id = $1) AND ($2::text IS NULL OR status = $2)
      ORDER BY created_at DESC LIMIT 200`, [f.clientId ?? null, f.status ?? null]);
  return { drafts: rows.map(view) };
}

export async function createDraft(op: Operator, clientId: string, p: DraftPayload) {
  const { rows: [cl] } = await pool.query('SELECT status FROM clients WHERE id = $1', [clientId]);
  if (!cl) throw new HttpError(404, 'Cliente no encontrado', 'not_found');
  if (cl.status === 'closed') throw conflict('Cliente cerrado', 'client_closed');
  let payload: Record<string, unknown>;
  if (p.kind === 'whitelist') {
    if (!isAddress(p.address)) throw new HttpError(400, 'Dirección inválida', 'invalid_address');
    payload = { address: p.address.toLowerCase(), network: net(p.network ?? primaryNet.id).id, label: p.label ?? null };
  } else {
    const { rows: [a] } = await pool.query('SELECT id FROM assets WHERE id = $1 AND active', [p.asset_id]);
    if (!a) throw new HttpError(404, 'Activo no encontrado', 'not_found');
    payload = { asset_id: p.asset_id, threshold: p.threshold };
  }
  const { rows: [d] } = await pool.query(
    `INSERT INTO client_config_drafts (client_id, kind, payload, created_by, created_by_email) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
    [clientId, p.kind, payload, op.id, op.email]);
  return view(d);
}

async function lockDraft(c: Tx, id: string) {
  const { rows: [d] } = await c.query('SELECT * FROM client_config_drafts WHERE id = $1 FOR UPDATE', [id]);
  if (!d) throw NOT_FOUND();
  return d;
}

/** Envía el borrador a tesorería. Solo quien lo preparó. */
export async function submitDraft(op: Operator, id: string) {
  return tx(async (c) => {
    const d = await lockDraft(c, id);
    if (d.created_by !== op.id) throw new HttpError(403, 'Solo quien preparó el borrador puede enviarlo', 'forbidden');
    if (d.status !== 'draft') throw conflict('El borrador ya no está en edición', 'not_draft');
    const { rows: [r] } = await c.query(`UPDATE client_config_drafts SET status = 'submitted', submitted_at = now() WHERE id = $1 RETURNING *`, [id]);
    return view(r);
  });
}

/** Cancela el borrador (quien lo preparó) o lo retira de tesorería (un tesorero). */
export async function cancelDraft(op: Operator, id: string) {
  return tx(async (c) => {
    const d = await lockDraft(c, id);
    if (d.created_by !== op.id && op.role !== 'tesorero') throw new HttpError(403, 'Solo quien lo preparó o un tesorero puede cancelarlo', 'forbidden');
    if (d.status !== 'draft' && d.status !== 'submitted') throw conflict('El borrador ya fue resuelto', 'already_decided');
    const { rows: [r] } = await c.query(
      `UPDATE client_config_drafts SET status = 'cancelled', decided_by = $2, decided_by_email = $3, decided_at = now() WHERE id = $1 RETURNING *`,
      [id, op.id, op.email]);
    return view(r);
  });
}

export async function rejectDraft(op: Operator, id: string, note: string) {
  return tx(async (c) => {
    const d = await lockDraft(c, id);
    if (d.status !== 'submitted') throw conflict('El borrador no está pendiente de tesorería', 'not_submitted');
    const { rows: [r] } = await c.query(
      `UPDATE client_config_drafts SET status = 'rejected', decided_by = $2, decided_by_email = $3, decided_at = now(), decision_note = $4
        WHERE id = $1 RETURNING *`, [id, op.id, op.email, note]);
    return view(r);
  });
}

/** Libera: aplica la configuración al cliente en la misma transacción. */
export async function releaseDraft(op: Operator, id: string) {
  return tx(async (c) => {
    const d = await lockDraft(c, id);
    if (d.status !== 'submitted') throw conflict('El borrador no está pendiente de tesorería', 'not_submitted');
    if (d.created_by === op.id) throw new HttpError(403, 'Quien preparó el borrador no puede liberarlo', 'same_user');
    const ref = d.kind === 'whitelist' ? await applyWhitelist(c, d, op) : await applyThreshold(c, d, op);
    const { rows: [r] } = await c.query(
      `UPDATE client_config_drafts SET status = 'released', decided_by = $2, decided_by_email = $3, decided_at = now(), applied_ref = $4
        WHERE id = $1 RETURNING *`, [id, op.id, op.email, ref]);
    return view(r);
  });
}

async function applyWhitelist(c: Tx, d: Record<string, any>, op: Operator): Promise<string> {
  const { address, network, label } = d.payload as { address: string; network: string; label: string | null };
  const { rows: [cl] } = await c.query('SELECT status FROM clients WHERE id = $1 FOR SHARE', [d.client_id]);
  if (cl.status === 'closed') throw conflict('Cliente cerrado', 'client_closed');
  const cooldown = Math.round(config.WHITELIST_COOLDOWN_HOURS * 3600);
  const by = `consola:${op.email}`;
  const { rows: [ex] } = await c.query('SELECT * FROM wallets WHERE network = $1 AND address = $2 FOR UPDATE', [network, address]);
  if (ex) {
    if (ex.client_id !== d.client_id || ex.purpose !== 'withdrawal_whitelist') throw conflict('Esa dirección no se puede registrar', 'address_unavailable');
    if (ex.wl_status !== 'removed') throw conflict('Esa dirección ya está en la lista blanca o por aprobar', 'already_listed');
    await c.query(
      `UPDATE wallets SET wl_status = 'active', active = true, wl_requested_by = NULL, wl_requested_at = now(), wl_requested_by_email = $2,
              wl_approved_by = NULL, wl_approved_at = now(), wl_approved_by_email = $3, active_from = now() + make_interval(secs => $4),
              removed_at = NULL, removed_by = NULL, label = COALESCE($5, label) WHERE id = $1`,
      [ex.id, d.created_by_email, by, cooldown, label]);
    return ex.id;
  }
  const { rows: [w] } = await c.query(
    `INSERT INTO wallets (client_id, chain, network, address, purpose, label, active, wl_status, wl_requested_at, wl_requested_by_email,
                          wl_approved_at, wl_approved_by_email, active_from)
     VALUES ($1,'ethereum',$2,$3,'withdrawal_whitelist',$4,true,'active',now(),$5,now(),$6, now() + make_interval(secs => $7)) RETURNING id`,
    [d.client_id, network, address, label, d.created_by_email, by, cooldown]);
  return w.id;
}

async function applyThreshold(c: Tx, d: Record<string, any>, op: Operator): Promise<string> {
  const { asset_id, threshold } = d.payload as { asset_id: string; threshold: string | null };
  if (threshold === null) {
    await c.query('DELETE FROM client_approval_thresholds WHERE client_id = $1 AND asset_id = $2', [d.client_id, asset_id]);
  } else {
    await c.query(
      `INSERT INTO client_approval_thresholds (client_id, asset_id, threshold, updated_by, updated_by_email) VALUES ($1,$2,$3,NULL,$4)
       ON CONFLICT (client_id, asset_id) DO UPDATE SET threshold = EXCLUDED.threshold, updated_by = NULL,
         updated_by_email = EXCLUDED.updated_by_email, updated_by_name = NULL, updated_at = now()`,
      [d.client_id, asset_id, threshold, `consola:${op.email}`]);
  }
  return asset_id;
}
