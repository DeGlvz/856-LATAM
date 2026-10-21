// Administración de operadores de 856: alta por invitación (enlace de un solo uso), cambio de rol y baja lógica.
// Mismo diseño que las invitaciones del portal: el token viaja en el fragmento (#) y en la base solo queda su SHA-256.
import { createHash, randomBytes } from 'node:crypto';
import { config } from '../config.js';
import { pool, tx, type Tx } from '../db.js';
import { HttpError } from '../idempotency.js';
import { consumeTotp, hashPassword, PASSWORD_MIN, type Operator, type Role } from './operators.js';

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const INVALID = () => new HttpError(404, 'Invitación inválida, usada, revocada o vencida', 'invalid_invite');
// Serializa las decisiones sobre la plantilla de tesorería (evita dos degradaciones cruzadas simultáneas)
export const ROSTER_LOCK = 856012;

/** Step-up: toda escritura de este módulo exige un código TOTP vigente y no usado del tesorero que actúa. */
export function requireTotpActor(o: Operator) {
  if (!o.totp_enabled) throw new HttpError(403, 'Para administrar operadores necesita el 2FA activo (Seguridad → Activar 2FA)', 'totp_required');
}
export async function stepUp(o: Operator, code: string) {
  requireTotpActor(o);
  if ((await consumeTotp(o.id, code)) == null) throw new HttpError(422, 'Código 2FA incorrecto o ya usado', 'bad_code');
}

// ═════════════ Invitaciones ═════════════
export async function createOperatorInvite(actor: Operator, i: { email: string; role: Role }) {
  const email = i.email.trim().toLowerCase();
  return tx(async (c) => {
    await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`operator_invite:${email}`]);
    const { rows: [o] } = await c.query('SELECT active FROM operators WHERE email = $1', [email]);
    if (o?.active) throw new HttpError(409, 'Ese correo ya es operador activo', 'email_in_use');
    if (o) throw new HttpError(409, 'Ese correo pertenece a un operador desactivado: reactívelo en lugar de invitarlo', 'operator_inactive');
    const { rows: [open] } = await c.query(
      'SELECT 1 FROM operator_invites WHERE email = $1 AND used_at IS NULL AND revoked_at IS NULL AND expires_at > now()', [email]);
    if (open) throw new HttpError(409, 'Ya hay una invitación vigente para ese correo: revóquela para emitir otra', 'invite_pending');
    const token = randomBytes(32).toString('base64url');
    const expires_at = new Date(Date.now() + config.CONSOLE_INVITE_TTL_HOURS * 3600_000);
    const { rows: [inv] } = await c.query(
      `INSERT INTO operator_invites (email, role, token_hash, created_by, expires_at) VALUES ($1,$2,$3,$4,$5)
       RETURNING id, email, role, expires_at`, [email, i.role, sha(token), actor.id, expires_at]);
    // El enlace se entrega una sola vez; el token va en el fragmento (#) y nunca llega a registros de servidor
    return { ...inv, link: `/console/invitacion#${token}` } as { id: string; email: string; role: Role; expires_at: Date; link: string };
  });
}

type Link = { id: string; email: string; role: Role; expires_at: Date; link: string };

async function issueLink(c: Tx, actor: Operator, email: string, role: Role, operatorId: string | null): Promise<Link> {
  const token = randomBytes(32).toString('base64url');
  const expires_at = new Date(Date.now() + config.CONSOLE_INVITE_TTL_HOURS * 3600_000);
  const { rows: [inv] } = await c.query(
    `INSERT INTO operator_invites (email, role, token_hash, created_by, expires_at, operator_id) VALUES ($1,$2,$3,$4,$5,$6)
     RETURNING id, email, role, expires_at`, [email, role, sha(token), actor.id, expires_at, operatorId]);
  return { ...inv, link: `/console/invitacion#${token}` };
}

/** Reenvía el acceso de un operador existente (olvidó la contraseña o nunca entró): enlace nuevo; los anteriores quedan revocados. */
export async function resendOperatorAccess(actor: Operator, operatorId: string) {
  if (operatorId === actor.id) throw new HttpError(403, 'Use Seguridad para su propia cuenta: pídalo a otro tesorero', 'self_change');
  return tx(async (c) => {
    const { rows: [o] } = await c.query('SELECT id, email, role, active FROM operators WHERE id = $1 FOR UPDATE', [operatorId]);
    if (!o) throw new HttpError(404, 'Operador no encontrado', 'not_found');
    if (!o.active) throw new HttpError(409, 'El operador está desactivado: reactívelo primero', 'operator_inactive');
    await c.query(`UPDATE operator_invites SET revoked_at = now() WHERE operator_id = $1 AND used_at IS NULL AND revoked_at IS NULL`, [operatorId]);
    return issueLink(c, actor, o.email, o.role, operatorId);
  });
}

/** Reenvía una invitación pendiente: revoca el enlace anterior (que ya no se puede ver) y emite uno nuevo. */
export async function resendOperatorInvite(actor: Operator, id: string) {
  return tx(async (c) => {
    const { rows: [inv] } = await c.query(
      `SELECT id, email, role, operator_id FROM operator_invites WHERE id = $1 AND used_at IS NULL AND revoked_at IS NULL FOR UPDATE`, [id]);
    if (!inv) throw new HttpError(409, 'La invitación ya fue usada o revocada', 'invite_not_pending');
    await c.query('UPDATE operator_invites SET revoked_at = now() WHERE id = $1', [id]);
    return issueLink(c, actor, inv.email, inv.role, inv.operator_id);
  });
}

export async function listOperatorInvites() {
  const { rows } = await pool.query(
    `SELECT i.id, i.email, i.role, i.created_at, i.expires_at, o.email AS created_by, i.operator_id IS NOT NULL AS is_access_reset
       FROM operator_invites i JOIN operators o ON o.id = i.created_by
      WHERE i.used_at IS NULL AND i.revoked_at IS NULL AND i.expires_at > now()
      ORDER BY i.created_at DESC LIMIT 500`);
  return rows;
}

export async function revokeOperatorInvite(id: string) {
  const { rows: [inv] } = await pool.query('SELECT email, role, used_at, revoked_at FROM operator_invites WHERE id = $1', [id]);
  if (!inv) throw new HttpError(404, 'Invitación no encontrada', 'not_found');
  const r = await pool.query('UPDATE operator_invites SET revoked_at = now() WHERE id = $1 AND used_at IS NULL AND revoked_at IS NULL', [id]);
  if (!r.rowCount) throw new HttpError(409, 'La invitación ya fue usada o revocada', 'invite_not_pending');
  return { id, email: inv.email as string, role: inv.role as Role, revoked: true };
}

async function openInvite(c: Tx | typeof pool, token: string, lock = false) {
  if (token.length > 100) throw INVALID();
  const { rows: [inv] } = await c.query(
    `SELECT id, email, role, expires_at, created_by, operator_id FROM operator_invites
      WHERE token_hash = $1 AND used_at IS NULL AND revoked_at IS NULL AND expires_at > now()${lock ? ' FOR UPDATE' : ''}`, [sha(token)]);
  if (!inv) throw INVALID();
  return inv as { id: string; email: string; role: Role; expires_at: Date; created_by: string; operator_id: string | null };
}

export async function lookupOperatorInvite(token: string) {
  const inv = await openInvite(pool, token);
  return { email: inv.email, role: inv.role, expires_at: inv.expires_at };
}

/** Canjea la invitación: crea el operador y marca el enlace como usado, todo o nada. */
export async function acceptOperatorInvite(token: string, name: string, password: string) {
  if (password.length < PASSWORD_MIN) throw new HttpError(400, `La contraseña requiere al menos ${PASSWORD_MIN} caracteres`, 'weak_password');
  const password_hash = await hashPassword(password); // fuera de la transacción: argon2 tarda
  try {
    return await tx(async (c) => {
      const inv = await openInvite(c, token, true);
      if (inv.operator_id) {
        // Acceso reenviado a un operador existente: nueva contraseña, desbloqueo y cierre de sesiones previas
        const { rows: [o] } = await c.query(
          `UPDATE operators SET password_hash = $2, name = $3, failed_attempts = 0, locked_until = NULL
            WHERE id = $1 AND active RETURNING id, email, name, role`, [inv.operator_id, password_hash, name.trim()]);
        if (!o) throw INVALID();
        await c.query('UPDATE operator_sessions SET revoked_at = now() WHERE operator_id = $1 AND revoked_at IS NULL', [o.id]);
        await c.query('UPDATE operator_invites SET used_at = now() WHERE id = $1', [inv.id]);
        return { operator: o as { id: string; email: string; name: string; role: Role }, invite_id: inv.id, invited_by: inv.created_by };
      }
      const { rows: [dup] } = await c.query('SELECT 1 FROM operators WHERE email = $1', [inv.email]);
      if (dup) throw new HttpError(409, 'Ese correo ya es operador', 'email_in_use');
      const { rows: [o] } = await c.query(
        `INSERT INTO operators (email, name, password_hash, role) VALUES ($1,$2,$3,$4) RETURNING id, email, name, role`,
        [inv.email, name.trim(), password_hash, inv.role]);
      await c.query('UPDATE operator_invites SET used_at = now() WHERE id = $1', [inv.id]);
      return { operator: o as { id: string; email: string; name: string; role: Role }, invite_id: inv.id, invited_by: inv.created_by };
    });
  } catch (e) {
    if ((e as { code?: string }).code === '23505') throw new HttpError(409, 'Ese correo ya es operador', 'email_in_use');
    throw e;
  }
}

// ═════════════ Rol y estado ═════════════
/**
 * Cambia rol y/o estado de otro operador. Nadie se modifica a sí mismo y el sistema nunca se queda sin un tesorero
 * activo con 2FA. Cambiar el rol o desactivar revoca sus sesiones; reactivar no las restaura.
 */
export async function updateOperator(actor: Operator, id: string, p: { role?: Role; active?: boolean }) {
  if (id === actor.id) throw new HttpError(403, 'No puede cambiar su propio rol o estado: pídalo a otro tesorero', 'self_change');
  return tx(async (c) => {
    await c.query('SELECT pg_advisory_xact_lock($1)', [ROSTER_LOCK]);
    const { rows: [t] } = await c.query('SELECT id, email, role, active FROM operators WHERE id = $1 FOR UPDATE', [id]);
    if (!t) throw new HttpError(404, 'Operador no encontrado', 'not_found');
    const roleChanged = p.role !== undefined && p.role !== t.role;
    const activeChanged = p.active !== undefined && p.active !== t.active;
    const { rows: [u] } = await c.query(
      `UPDATE operators SET role = $2, active = $3,
              deactivated_at = CASE WHEN $3 THEN NULL WHEN $4 THEN now() ELSE deactivated_at END,
              deactivated_by = CASE WHEN $3 THEN NULL WHEN $4 THEN $5::uuid ELSE deactivated_by END
        WHERE id = $1
        RETURNING id, email, name, role, active, totp_enabled_at IS NOT NULL AS totp_enabled, deactivated_at`,
      [id, roleChanged ? p.role : t.role, activeChanged ? p.active : t.active, activeChanged && p.active === false, actor.id]);
    const { rows: [n] } = await c.query(
      `SELECT count(*)::int AS n FROM operators WHERE role = 'tesorero' AND active AND totp_enabled_at IS NOT NULL`);
    if (n.n < 1) throw new HttpError(409, 'Debe quedar al menos un tesorero activo con 2FA', 'last_treasurer');
    // Quien actúa debe seguir siendo tesorero activo (pudo ser degradado por otra petición en paralelo)
    const { rows: [a] } = await c.query(`SELECT 1 FROM operators WHERE id = $1 AND active AND role = 'tesorero'`, [actor.id]);
    if (!a) throw new HttpError(403, 'Su rol o estado cambió: vuelva a iniciar sesión', 'forbidden');
    let sessions_revoked = 0;
    if (roleChanged || (activeChanged && p.active === false)) {
      const r = await c.query('UPDATE operator_sessions SET revoked_at = now() WHERE operator_id = $1 AND revoked_at IS NULL', [id]);
      sessions_revoked = r.rowCount ?? 0;
    }
    return { operator: u, changes: { from: { role: t.role, active: t.active }, role_changed: roleChanged, active_changed: activeChanged }, sessions_revoked };
  });
}

/**
 * El propio operador apaga su 2FA. Un tesorero no puede hacerlo si es el último tesorero activo con 2FA
 * (nadie podría administrar operadores ni aprobar con step-up). Se evalúa antes de gastar el código.
 */
export async function disableOwnTotp(o: Operator, code: string) {
  return tx(async (c) => {
    await c.query('SELECT pg_advisory_xact_lock($1)', [ROSTER_LOCK]);
    const { rows: [me] } = await c.query(
      `SELECT role, active, totp_enabled_at IS NOT NULL AS totp_on FROM operators WHERE id = $1`, [o.id]);
    if (!me?.totp_on) throw new HttpError(409, 'El 2FA no está activo', 'totp_not_enabled');
    if (me.role === 'tesorero' && me.active) {
      const { rows: [n] } = await c.query(
        `SELECT count(*)::int AS n FROM operators WHERE role = 'tesorero' AND active AND totp_enabled_at IS NOT NULL AND id <> $1`, [o.id]);
      if (n.n < 1) throw new HttpError(409, 'Es el último tesorero activo con 2FA: no puede desactivarlo hasta que otro tesorero lo active', 'last_treasurer');
    }
    if ((await consumeTotp(o.id, code)) == null) throw new HttpError(422, 'Código incorrecto o ya usado', 'bad_code');
    await c.query(
      'UPDATE operators SET totp_secret_enc = NULL, totp_pending_enc = NULL, totp_enabled_at = NULL, totp_last_step = NULL WHERE id = $1', [o.id]);
  });
}

// ═════════════ Alertas del portal ═════════════
/** Clientes con usuarios activos en el portal y menos de 2 admins activos (la recuperación nivel 2 exige ≥ 2). */
export async function portalAlerts() {
  const { rows } = await pool.query(
    `SELECT c.id AS client_id, c.name,
            count(*) FILTER (WHERE u.role = 'admin')::int AS admins, count(*)::int AS users
       FROM client_users u JOIN clients c ON c.id = u.client_id
      WHERE u.active AND c.status <> 'closed'
      GROUP BY c.id, c.name
     HAVING count(*) FILTER (WHERE u.role = 'admin') < 2
      ORDER BY admins, c.name`);
  return { clients: rows };
}
