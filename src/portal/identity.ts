// Portal de clientes — identidad: usuarios por cliente, sesiones, 2FA, códigos de recuperación, invitaciones y llaves de API.
// Regla de oro: el client_id SIEMPRE sale de la sesión o de la llave, nunca de lo que mande el navegador.
import { createHash, createPublicKey, randomBytes, timingSafeEqual, verify as edVerify } from 'node:crypto';
import { BlockList, isIP } from 'node:net';
import { hash, verify } from '@node-rs/argon2';
import { config } from '../config.js';
import { pool, tx } from '../db.js';
import { HttpError } from '../idempotency.js';
import { decryptSecret, encryptSecret, generateSecret, otpauthUrl, verifyCode } from '../auth/totp.js';

export type ClientRole = 'viewer' | 'operator' | 'approver' | 'admin';
export const CLIENT_ROLES: ClientRole[] = ['viewer', 'operator', 'approver', 'admin'];
const RANK: Record<ClientRole, number> = { viewer: 0, operator: 1, approver: 2, admin: 3 };
export const roleAtLeast = (have: ClientRole, need: ClientRole) => RANK[have] >= RANK[need];
/** approver y admin no pueden operar sin 2FA */
export const roleNeeds2fa = (r: ClientRole) => r === 'approver' || r === 'admin';

export interface ClientUser { id: string; client_id: string; email: string; name: string; role: ClientRole; totp_enabled: boolean }
export interface ClientKey { id: string; client_id: string; prefix: string; kind: 'ed25519' | 'read_token'; permissions: string[] }
export type PortalPrincipal =
  | { kind: 'client_user'; clientId: string; user: ClientUser; sessionId: string }
  | { kind: 'client_key'; clientId: string; key: ClientKey }
  | { kind: 'assist'; clientId: string; operatorId: string; operatorEmail: string; operatorName: string; expiresAt: Date };

declare module 'fastify' {
  interface FastifyRequest { portal?: PortalPrincipal }
}

const ARGON = { memoryCost: 19456, timeCost: 2, parallelism: 1 };
const DUMMY = hash(randomBytes(16).toString('hex'), ARGON);
export const sha = (s: string | Buffer) => createHash('sha256').update(s).digest('hex');
const b64u = (n: number) => randomBytes(n).toString('base64url');
export const PORTAL_COOKIE = config.COOKIE_SECURE ? '__Host-c856p' : 'c856p';
export const PASSWORD_MIN = 12;
const MFA_TTL_MS = 5 * 60_000;

const userCols = `u.id, u.client_id, u.email, u.name, u.role, u.totp_enabled_at IS NOT NULL AS totp_enabled`;

// ═════════════ Invitaciones (alta de usuarios sin enviar contraseñas) ═════════════
export async function createInvite(i: { clientId: string; email: string; role: ClientRole; createdBy: string }) {
  const email = i.email.trim().toLowerCase();
  const { rows: [cl] } = await pool.query('SELECT status FROM clients WHERE id = $1', [i.clientId]);
  if (!cl) throw new HttpError(404, 'Cliente no encontrado', 'not_found');
  if (cl.status === 'closed') throw new HttpError(409, 'Cliente cerrado', 'client_closed');
  const { rows: [dup] } = await pool.query('SELECT client_id FROM client_users WHERE email = $1', [email]);
  // Mismo mensaje exista o no en otro cliente: no se revela a qué cliente pertenece un correo
  if (dup) throw new HttpError(409, 'Ese correo ya tiene acceso al portal', 'email_in_use');
  await pool.query(`UPDATE client_invites SET revoked_at = now() WHERE client_id = $1 AND email = $2 AND used_at IS NULL AND revoked_at IS NULL`,
    [i.clientId, email]);
  const token = b64u(32);
  const expires_at = new Date(Date.now() + config.PORTAL_INVITE_TTL_HOURS * 3600_000);
  const { rows: [inv] } = await pool.query(
    `INSERT INTO client_invites (client_id, email, role, token_hash, created_by, expires_at) VALUES ($1,$2,$3,$4,$5,$6)
     RETURNING id, email, role, expires_at, created_at`, [i.clientId, email, i.role, sha(token), i.createdBy, expires_at]);
  // El enlace se muestra una sola vez; el token va en el fragmento (#) y nunca llega a registros de servidor
  return { ...inv, link: `/portal/invitacion#${token}` };
}

async function openInvite(token: string) {
  const { rows: [inv] } = await pool.query(
    `SELECT i.*, c.name AS client_name, c.status AS client_status FROM client_invites i JOIN clients c ON c.id = i.client_id
      WHERE i.token_hash = $1 AND i.used_at IS NULL AND i.revoked_at IS NULL AND i.expires_at > now()`, [sha(token)]);
  if (!inv || inv.client_status === 'closed') throw new HttpError(404, 'Invitación inválida, usada o vencida', 'invalid_invite');
  return inv;
}

export async function lookupInvite(token: string) {
  const inv = await openInvite(token);
  return { email: inv.email, role: inv.role, client_name: inv.client_name, expires_at: inv.expires_at, requires_2fa: roleNeeds2fa(inv.role) };
}

export async function acceptInvite(token: string, name: string, password: string) {
  if (password.length < PASSWORD_MIN) throw new HttpError(400, `La contraseña requiere al menos ${PASSWORD_MIN} caracteres`, 'weak_password');
  const inv = await openInvite(token);
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const used = await c.query('UPDATE client_invites SET used_at = now() WHERE id = $1 AND used_at IS NULL RETURNING id', [inv.id]);
    if (!used.rowCount) throw new HttpError(404, 'Invitación inválida, usada o vencida', 'invalid_invite');
    const { rows: [u] } = await c.query(
      `INSERT INTO client_users (client_id, email, name, role, password_hash) VALUES ($1,$2,$3,$4,$5)
       RETURNING id, client_id, email, role`, [inv.client_id, inv.email, name.trim(), inv.role, await hash(password, ARGON)]);
    await c.query('COMMIT');
    return { ...u, requires_2fa: roleNeeds2fa(u.role) };
  } catch (e) {
    await c.query('ROLLBACK');
    if ((e as { code?: string }).code === '23505') throw new HttpError(409, 'Ese correo ya tiene acceso al portal', 'email_in_use');
    throw e;
  } finally { c.release(); }
}

// ═════════════ Login en uno o dos pasos ═════════════
async function registerFailure(userId: string) {
  await pool.query(
    `UPDATE client_users SET failed_attempts = failed_attempts + 1,
            locked_until = CASE WHEN failed_attempts + 1 >= $2 THEN now() + make_interval(mins => $3) END WHERE id = $1`,
    [userId, config.LOGIN_MAX_FAILS, config.LOGIN_LOCK_MIN]);
}

async function createSession(u: { id: string; client_id: string }, meta: { ip?: string; ua?: string }) {
  const token = b64u(32);
  const expires_at = new Date(Date.now() + config.PORTAL_SESSION_TTL_MIN * 60_000);
  await pool.query(
    `INSERT INTO client_sessions (token_hash, user_id, client_id, ip, user_agent, expires_at) VALUES ($1,$2,$3,$4,$5,$6)`,
    [sha(token), u.id, u.client_id, meta.ip ?? null, meta.ua?.slice(0, 300) ?? null, expires_at]);
  await pool.query('UPDATE client_users SET failed_attempts = 0, locked_until = NULL, last_login_at = now() WHERE id = $1', [u.id]);
  return { token, expires_at };
}

export async function login(email: string, password: string, meta: { ip?: string; ua?: string }) {
  const { rows: [u] } = await pool.query(
    `SELECT ${userCols}, u.password_hash, u.active, u.locked_until, c.status AS client_status
       FROM client_users u JOIN clients c ON c.id = u.client_id WHERE u.email = $1`, [email.trim().toLowerCase()]);
  if (!u) { await verify(await DUMMY, password).catch(() => false); return { ok: false as const, reason: 'unknown' }; }
  const valid = await verify(u.password_hash, password).catch(() => false);
  if (!u.active || u.client_status === 'closed') return { ok: false as const, reason: 'inactive', user: u };
  if (u.locked_until && new Date(u.locked_until) > new Date()) return { ok: false as const, reason: 'locked', user: u };
  if (!valid) { await registerFailure(u.id); return { ok: false as const, reason: 'bad_password', user: u }; }
  const user: ClientUser = { id: u.id, client_id: u.client_id, email: u.email, name: u.name, role: u.role, totp_enabled: u.totp_enabled };
  if (u.totp_enabled) {
    const challenge = b64u(32);
    await pool.query('INSERT INTO client_mfa_challenges (token_hash, user_id, expires_at) VALUES ($1,$2,$3)',
      [sha(challenge), u.id, new Date(Date.now() + MFA_TTL_MS)]);
    return { ok: true as const, mfa: true as const, user, challenge };
  }
  return { ok: true as const, mfa: false as const, user, ...(await createSession(u, meta)) };
}

/** Verifica y consume un código TOTP (anti-reuso por paso de tiempo). */
export async function consumeTotp(userId: string, code: string) {
  const { rows: [u] } = await pool.query('SELECT totp_secret_enc, totp_last_step FROM client_users WHERE id = $1', [userId]);
  if (!u?.totp_secret_enc) return false;
  const step = verifyCode(decryptSecret(u.totp_secret_enc), code, u.totp_last_step == null ? null : Number(u.totp_last_step));
  if (step == null) return false;
  const r = await pool.query('UPDATE client_users SET totp_last_step = $2 WHERE id = $1 AND (totp_last_step IS NULL OR totp_last_step < $2)', [userId, step]);
  return !!r.rowCount;
}

async function consumeRecoveryCode(userId: string, code: string) {
  const norm = code.replace(/[^a-z0-9]/gi, '').toLowerCase();
  const r = await pool.query('UPDATE client_recovery_codes SET used_at = now() WHERE user_id = $1 AND code_hash = $2 AND used_at IS NULL',
    [userId, sha(norm)]);
  return !!r.rowCount;
}

export async function completeMfa(challenge: string, f: { code?: string; recovery_code?: string }, meta: { ip?: string; ua?: string }) {
  const { rows: [ch] } = await pool.query(
    `SELECT m.token_hash, m.attempts, ${userCols}, u.active, u.locked_until FROM client_mfa_challenges m
       JOIN client_users u ON u.id = m.user_id WHERE m.token_hash = $1 AND m.used_at IS NULL AND m.expires_at > now()`, [sha(challenge)]);
  if (!ch || !ch.active || ch.attempts >= 5 || (ch.locked_until && new Date(ch.locked_until) > new Date())) {
    return { ok: false as const, reason: 'invalid_challenge', user: ch };
  }
  const ok = f.recovery_code ? await consumeRecoveryCode(ch.id, f.recovery_code) : !!f.code && await consumeTotp(ch.id, f.code);
  if (!ok) {
    await pool.query('UPDATE client_mfa_challenges SET attempts = attempts + 1 WHERE token_hash = $1', [ch.token_hash]);
    await registerFailure(ch.id);
    return { ok: false as const, reason: 'bad_code', user: ch };
  }
  await pool.query('UPDATE client_mfa_challenges SET used_at = now() WHERE token_hash = $1', [ch.token_hash]);
  const user: ClientUser = { id: ch.id, client_id: ch.client_id, email: ch.email, name: ch.name, role: ch.role, totp_enabled: true };
  return { ok: true as const, user, recovery: !!f.recovery_code, ...(await createSession(ch, meta)) };
}

export async function sessionFromToken(token: string | undefined) {
  if (!token || token.length > 100) return null;
  const { rows: [s] } = await pool.query(
    `SELECT s.id AS session_id, s.last_seen_at, ${userCols} FROM client_sessions s
       JOIN client_users u ON u.id = s.user_id JOIN clients c ON c.id = u.client_id
      WHERE s.token_hash = $1 AND s.revoked_at IS NULL AND s.expires_at > now()
        AND s.last_seen_at > now() - make_interval(mins => $2) AND u.active AND c.status <> 'closed'`,
    [sha(token), config.PORTAL_SESSION_IDLE_MIN]);
  if (!s) return null;
  if (Date.now() - new Date(s.last_seen_at).getTime() > 60_000) await pool.query('UPDATE client_sessions SET last_seen_at = now() WHERE id = $1', [s.session_id]);
  const user: ClientUser = { id: s.id, client_id: s.client_id, email: s.email, name: s.name, role: s.role, totp_enabled: s.totp_enabled };
  return { user, sessionId: s.session_id as string };
}

export const revokeSession = (id: string) => pool.query('UPDATE client_sessions SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL', [id]);
export const revokeUserSessions = (userId: string) =>
  pool.query('UPDATE client_sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL', [userId]);

// ═════════════ 2FA y códigos de recuperación ═════════════
export async function totpSetup(u: ClientUser) {
  if (u.totp_enabled) throw new HttpError(409, 'El 2FA ya está activo', 'totp_already_enabled');
  const secret = generateSecret();
  await pool.query('UPDATE client_users SET totp_pending_enc = $2 WHERE id = $1', [u.id, encryptSecret(secret)]);
  return { secret, otpauth_url: otpauthUrl(secret, u.email) };
}

async function issueRecoveryCodes(userId: string) {
  await pool.query('DELETE FROM client_recovery_codes WHERE user_id = $1', [userId]);
  const codes = Array.from({ length: 10 }, () => {
    const raw = randomBytes(8).toString('hex').slice(0, 10); // 40 bits por código, un solo uso
    return `${raw.slice(0, 5)}-${raw.slice(5)}`;
  });
  for (const c of codes) await pool.query('INSERT INTO client_recovery_codes (user_id, code_hash) VALUES ($1,$2)', [userId, sha(c.replace('-', ''))]);
  return codes;
}

export async function totpEnable(u: ClientUser, code: string) {
  const { rows: [r] } = await pool.query('SELECT totp_pending_enc, totp_enabled_at FROM client_users WHERE id = $1', [u.id]);
  if (r.totp_enabled_at) throw new HttpError(409, 'El 2FA ya está activo', 'totp_already_enabled');
  if (!r.totp_pending_enc) throw new HttpError(409, 'Primero genere el secreto', 'totp_setup_required');
  const step = verifyCode(decryptSecret(r.totp_pending_enc), code, null);
  if (step == null) throw new HttpError(422, 'Código incorrecto', 'bad_code');
  await pool.query(`UPDATE client_users SET totp_secret_enc = totp_pending_enc, totp_pending_enc = NULL, totp_enabled_at = now(), totp_last_step = $2
                     WHERE id = $1`, [u.id, step]);
  return { totp_enabled: true, recovery_codes: await issueRecoveryCodes(u.id) };
}

export async function totpDisable(u: ClientUser, code: string) {
  if (roleNeeds2fa(u.role)) throw new HttpError(409, 'Su rol exige 2FA: no puede desactivarlo', 'totp_required_for_role');
  if (!(await consumeTotp(u.id, code))) throw new HttpError(422, 'Código incorrecto o ya usado', 'bad_code');
  await clearTotp(u.id);
  return { totp_enabled: false };
}

export async function regenerateRecoveryCodes(u: ClientUser, code: string) {
  if (!(await consumeTotp(u.id, code))) throw new HttpError(422, 'Código incorrecto o ya usado', 'bad_code');
  return { recovery_codes: await issueRecoveryCodes(u.id) };
}

export async function clearTotp(userId: string) {
  await pool.query(`UPDATE client_users SET totp_secret_enc = NULL, totp_pending_enc = NULL, totp_enabled_at = NULL, totp_last_step = NULL WHERE id = $1`, [userId]);
  await pool.query('DELETE FROM client_recovery_codes WHERE user_id = $1', [userId]);
}

// ═════════════ Usuarios del cliente (administración) ═════════════
export async function listUsers(clientId: string) {
  const { rows } = await pool.query(
    `SELECT u.id, u.email, u.name, u.role, u.active, u.totp_enabled_at IS NOT NULL AS totp_enabled, u.last_login_at, u.created_at,
            (SELECT count(*)::int FROM client_recovery_codes r WHERE r.user_id = u.id AND r.used_at IS NULL) AS recovery_codes_left
       FROM client_users u WHERE u.client_id = $1 ORDER BY u.created_at`, [clientId]);
  return rows;
}

/** Cambia rol o estado. Nunca deja al cliente sin un admin activo; nadie se cambia a sí mismo. */
export async function updateUser(clientId: string, actor: ClientUser, id: string, p: { role?: ClientRole; active?: boolean }) {
  if (id === actor.id) throw new HttpError(409, 'No puede cambiar su propio rol o estado', 'self_change');
  const { rows: [t] } = await pool.query('SELECT id, role, active FROM client_users WHERE id = $1 AND client_id = $2', [id, clientId]);
  if (!t) throw new HttpError(404, 'Usuario no encontrado', 'not_found');
  const losingAdmin = t.role === 'admin' && t.active && ((p.role && p.role !== 'admin') || p.active === false);
  if (losingAdmin) {
    const { rows: [n] } = await pool.query(`SELECT count(*)::int AS n FROM client_users WHERE client_id = $1 AND role = 'admin' AND active`, [clientId]);
    if (n.n <= 1) throw new HttpError(409, 'El cliente debe conservar al menos un admin activo', 'last_admin');
  }
  const { rows: [u] } = await pool.query(
    `UPDATE client_users SET role = COALESCE($3, role), active = COALESCE($4, active) WHERE id = $1 AND client_id = $2
     RETURNING id, email, name, role, active`, [id, clientId, p.role ?? null, p.active ?? null]);
  if (p.active === false || p.role) await revokeUserSessions(id); // el cambio aplica de inmediato
  return u;
}

/** Elimina un usuario únicamente cuando no tiene operaciones financieras abiertas. */
export async function deleteUser(clientId: string, actor: ClientUser, id: string) {
  if (id === actor.id) throw new HttpError(409, 'No puede eliminar su propio usuario', 'self_delete');
  return tx(async (c) => {
    const { rows: [user] } = await c.query(
      'SELECT id, email, name, role, active FROM client_users WHERE id = $1 AND client_id = $2 FOR UPDATE',
      [id, clientId]);
    if (!user) throw new HttpError(404, 'Usuario no encontrado', 'not_found');

    const { rows: [counts] } = await c.query(
      `SELECT
         (SELECT count(*)::int FROM obligations
           WHERE origin_kind = 'client_user' AND origin_ref = $1
             AND status IN ('pending_acceptance','open')) AS obligations,
         (SELECT count(*)::int FROM withdrawals
           WHERE origin_kind = 'client_user' AND origin_ref = $1
             AND status IN ('reserved','signed','broadcast')) AS withdrawals,
         (SELECT count(*)::int FROM fiat_payment_intents
           WHERE origin_kind = 'client_user' AND origin_ref = $1 AND status = 'open') AS fiat_intents`,
      [id]);
    const obligations = Number(counts.obligations);
    const withdrawals = Number(counts.withdrawals);
    const fiatIntents = Number(counts.fiat_intents);
    const pending = obligations + withdrawals + fiatIntents;
    if (pending) {
      throw new HttpError(409,
        `No se puede eliminar: hay operaciones financieras abiertas (obligaciones: ${obligations}, retiros: ${withdrawals}, avisos fiat: ${fiatIntents}).`,
        'user_has_open_financial_operations');
    }

    if (user.role === 'admin' && user.active) {
      const { rows: [admins] } = await c.query(
        `SELECT count(*)::int AS n FROM client_users WHERE client_id = $1 AND role = 'admin' AND active`,
        [clientId]);
      if (admins.n <= 1) throw new HttpError(409, 'El cliente debe conservar al menos un admin activo', 'last_admin');
    }

    const actorSnapshot = [id, user.email, user.name];
    await c.query(
      `UPDATE obligations o SET origin_user_email = $2, origin_user_name = $3
        WHERE o.origin_kind = 'client_user' AND o.origin_ref = $1 AND o.origin_user_email IS NULL`,
      actorSnapshot);
    await c.query(
      `UPDATE exit_simulations s SET origin_user_email = $2, origin_user_name = $3
        WHERE s.origin_kind = 'client_user' AND s.origin_ref = $1 AND s.origin_user_email IS NULL`,
      actorSnapshot);
    await c.query(
      `UPDATE withdrawals w SET
         origin_user_email = CASE WHEN w.origin_kind = 'client_user' AND w.origin_ref = $1 THEN $2 ELSE w.origin_user_email END,
         origin_user_name = CASE WHEN w.origin_kind = 'client_user' AND w.origin_ref = $1 THEN $3 ELSE w.origin_user_name END,
         client_approved_by_email = CASE WHEN w.client_approved_by = $1 THEN $2 ELSE w.client_approved_by_email END,
         client_approved_by_name = CASE WHEN w.client_approved_by = $1 THEN $3 ELSE w.client_approved_by_name END
       WHERE (w.origin_kind = 'client_user' AND w.origin_ref = $1) OR w.client_approved_by = $1`,
      actorSnapshot);
    await c.query(
      `UPDATE wallets SET
         wl_requested_by_email = CASE WHEN wl_requested_by = $1 THEN $2 ELSE wl_requested_by_email END,
         wl_requested_by_name = CASE WHEN wl_requested_by = $1 THEN $3 ELSE wl_requested_by_name END,
         wl_approved_by_email = CASE WHEN wl_approved_by = $1 THEN $2 ELSE wl_approved_by_email END,
         wl_approved_by_name = CASE WHEN wl_approved_by = $1 THEN $3 ELSE wl_approved_by_name END
       WHERE wl_requested_by = $1 OR wl_approved_by = $1`,
      actorSnapshot);
    await c.query(
      `UPDATE client_approval_thresholds SET updated_by_email = $2, updated_by_name = $3
        WHERE updated_by = $1 AND updated_by_email IS NULL`,
      actorSnapshot);
    await c.query(
      `UPDATE client_api_keys SET created_by_email = $2, created_by_name = $3, revoked_at = COALESCE(revoked_at, now())
        WHERE created_by = $1 AND created_by_email IS NULL`,
      actorSnapshot);

    await c.query('UPDATE withdrawals SET client_approved_by = NULL WHERE client_approved_by = $1', [id]);
    await c.query('UPDATE wallets SET wl_requested_by = NULL WHERE wl_requested_by = $1', [id]);
    await c.query('UPDATE wallets SET wl_approved_by = NULL WHERE wl_approved_by = $1', [id]);
    await c.query('UPDATE client_approval_thresholds SET updated_by = NULL WHERE updated_by = $1', [id]);
    await c.query('UPDATE client_api_keys SET created_by = NULL, revoked_at = COALESCE(revoked_at, now()) WHERE created_by = $1', [id]);
    await c.query('DELETE FROM client_sessions WHERE user_id = $1', [id]);
    await c.query('DELETE FROM client_mfa_challenges WHERE user_id = $1', [id]);
    await c.query('DELETE FROM client_recovery_codes WHERE user_id = $1', [id]);
    await c.query('DELETE FROM client_key_challenges WHERE user_id = $1', [id]);
    await c.query('DELETE FROM client_users WHERE id = $1 AND client_id = $2', [id, clientId]);
    return { id, deleted: true };
  });
}

/** Nivel 2 de recuperación: otro admin del cliente restablece el 2FA de un usuario. */
export async function resetUserTotp(clientId: string, actor: ClientUser, id: string) {
  if (id === actor.id) throw new HttpError(409, 'No puede restablecer su propio 2FA: pídalo a otro admin', 'self_reset');
  const { rows: [t] } = await pool.query('SELECT id FROM client_users WHERE id = $1 AND client_id = $2', [id, clientId]);
  if (!t) throw new HttpError(404, 'Usuario no encontrado', 'not_found');
  await clearTotp(id);
  await revokeUserSessions(id);
  return { ok: true };
}

export async function listInvites(clientId: string) {
  const { rows } = await pool.query(
    `SELECT id, email, role, created_by, expires_at, created_at FROM client_invites
      WHERE client_id = $1 AND used_at IS NULL AND revoked_at IS NULL AND expires_at > now() ORDER BY created_at DESC`, [clientId]);
  return rows;
}
export async function revokeInvite(clientId: string, id: string) {
  const r = await pool.query('UPDATE client_invites SET revoked_at = now() WHERE id = $1 AND client_id = $2 AND used_at IS NULL AND revoked_at IS NULL', [id, clientId]);
  if (!r.rowCount) throw new HttpError(404, 'Invitación no encontrada', 'not_found');
  return { ok: true };
}

// ═════════════ Llaves de API del cliente ═════════════
const SPKI_ED25519 = Buffer.from('302a300506032b6570032100', 'hex');
const edKey = (raw32: Buffer) => createPublicKey({ key: Buffer.concat([SPKI_ED25519, raw32]), format: 'der', type: 'spki' });
export const proofMessage = (challenge: string) => `856-latam/key-proof/v1:${challenge}`;
const READ_TOKEN_RE = /^856r_([0-9a-f]{16})_([A-Za-z0-9_-]{43})_([0-9a-f]{4})$/;
const checksum = (s: string) => sha(s).slice(0, 4);

export async function keyChallenge(u: ClientUser) {
  const challenge = b64u(32);
  await pool.query('INSERT INTO client_key_challenges (challenge, user_id, expires_at) VALUES ($1,$2,$3)', [challenge, u.id, new Date(Date.now() + 5 * 60_000)]);
  return { challenge, message: proofMessage(challenge), expires_in: 300 };
}

function parseAllowlist(list: string[]) {
  for (const e of list) {
    const [ip, bits] = e.split('/');
    const v = isIP(ip);
    if (!v || (bits !== undefined && !(Number(bits) >= 0 && Number(bits) <= (v === 4 ? 32 : 128)))) {
      throw new HttpError(400, `IP o rango inválido: ${e}`, 'invalid_ip');
    }
  }
  return list;
}

export interface NewKey {
  name: string; kind: 'ed25519' | 'read_token'; permissions?: string[]; ip_allowlist?: string[]; expires_days?: number;
  public_key?: string; challenge?: string; proof?: string;
}

export async function createKey(u: ClientUser, k: NewKey, rotatedFrom?: string) {
  const days = Math.min(k.expires_days ?? config.PORTAL_KEY_MAX_DAYS, config.PORTAL_KEY_MAX_DAYS);
  const expires_at = new Date(Date.now() + days * 86_400_000);
  const ips = parseAllowlist(k.ip_allowlist ?? []);
  const keyId = randomBytes(8).toString('hex');
  if (k.kind === 'ed25519') {
    const perms = [...new Set(k.permissions?.length ? k.permissions : ['read'])];
    if (!perms.every((p) => ['read', 'trade', 'withdraw'].includes(p))) throw new HttpError(400, 'Permiso inválido', 'invalid_permission');
    if (!k.public_key || !k.challenge || !k.proof) throw new HttpError(400, 'Falta la llave pública o la prueba de posesión', 'proof_required');
    const raw = Buffer.from(k.public_key, 'base64url');
    if (raw.length !== 32) throw new HttpError(400, 'Llave pública Ed25519 inválida (32 bytes)', 'invalid_public_key');
    // Prueba de posesión: el reto es de un solo uso, del mismo usuario y vigente
    const { rows: [ch] } = await pool.query(
      `UPDATE client_key_challenges SET used_at = now() WHERE challenge = $1 AND user_id = $2 AND used_at IS NULL AND expires_at > now() RETURNING challenge`,
      [k.challenge, u.id]);
    if (!ch) throw new HttpError(422, 'Reto inválido, usado o vencido', 'invalid_challenge');
    let ok = false;
    try { ok = edVerify(null, Buffer.from(proofMessage(k.challenge)), edKey(raw), Buffer.from(k.proof, 'base64url')); } catch { ok = false; }
    if (!ok) throw new HttpError(422, 'La prueba de posesión no corresponde a la llave pública', 'invalid_proof');
    const { rows: [key] } = await pool.query(
      `INSERT INTO client_api_keys (client_id, name, kind, prefix, public_key, permissions, ip_allowlist, expires_at, rotated_from, created_by)
       VALUES ($1,$2,'ed25519',$3,$4,$5,$6,$7,$8,$9) RETURNING id, name, kind, prefix, permissions, ip_allowlist, expires_at, created_at`,
      [u.client_id, k.name.trim(), `856k_${keyId}`, raw.toString('base64url'), perms, ips, expires_at, rotatedFrom ?? null, u.id]);
    return key;
  }
  // read_token: 256 bits del CSPRNG del servidor; se muestra una vez y se guarda solo su SHA-256
  const secret = b64u(32);
  const body = `856r_${keyId}_${secret}`;
  const token = `${body}_${checksum(body)}`;
  const { rows: [key] } = await pool.query(
    `INSERT INTO client_api_keys (client_id, name, kind, prefix, token_hash, permissions, ip_allowlist, expires_at, rotated_from, created_by)
     VALUES ($1,$2,'read_token',$3,$4,ARRAY['read'],$5,$6,$7,$8) RETURNING id, name, kind, prefix, permissions, ip_allowlist, expires_at, created_at`,
    [u.client_id, k.name.trim(), `856r_${keyId}`, sha(token), ips, expires_at, rotatedFrom ?? null, u.id]);
  return { ...key, token };
}

export async function listKeys(clientId: string) {
  const { rows } = await pool.query(
    `SELECT k.id, k.name, k.kind, k.prefix, k.permissions, k.ip_allowlist, k.expires_at, k.rotated_from, k.last_used_at, k.last_used_ip,
            k.revoked_at, k.locked_until, k.created_at, COALESCE(u.email, k.created_by_email) AS created_by
       FROM client_api_keys k LEFT JOIN client_users u ON u.id = k.created_by WHERE k.client_id = $1 ORDER BY k.created_at DESC`, [clientId]);
  return rows;
}

/** Rotación sin corte: la nueva nace vigente y la anterior sigue válida durante el traslape. */
export async function rotateKey(u: ClientUser, id: string, k: Omit<NewKey, 'kind' | 'name'> & { name?: string }) {
  const { rows: [old] } = await pool.query(
    `SELECT * FROM client_api_keys WHERE id = $1 AND client_id = $2 AND revoked_at IS NULL AND expires_at > now()`, [id, u.client_id]);
  if (!old) throw new HttpError(404, 'Llave no encontrada o ya inactiva', 'not_found');
  const fresh = await createKey(u, {
    ...k, kind: old.kind, name: k.name ?? old.name, permissions: k.permissions ?? old.permissions, ip_allowlist: k.ip_allowlist ?? old.ip_allowlist,
  }, old.id);
  const overlapEnd = new Date(Date.now() + config.PORTAL_KEY_OVERLAP_DAYS * 86_400_000);
  await pool.query('UPDATE client_api_keys SET expires_at = LEAST(expires_at, $2) WHERE id = $1', [old.id, overlapEnd]);
  return { ...fresh, previous_expires_at: overlapEnd < new Date(old.expires_at) ? overlapEnd : old.expires_at };
}

export async function revokeKey(clientId: string, id: string) {
  const { rows: [k] } = await pool.query(
    'UPDATE client_api_keys SET revoked_at = now() WHERE id = $1 AND client_id = $2 AND revoked_at IS NULL RETURNING id, prefix, revoked_at', [id, clientId]);
  if (!k) throw new HttpError(404, 'Llave no encontrada', 'not_found');
  return k;
}

// ═════════════ Autenticación por llave (cada petición) ═════════════
const ipAllowed = (ip: string, list: string[]) => {
  if (!list.length) return true;
  const addr = ip.startsWith('::ffff:') ? ip.slice(7) : ip;
  const bl = new BlockList();
  for (const e of list) {
    const [a, bits] = e.split('/');
    const type = isIP(a) === 6 ? 'ipv6' : 'ipv4';
    if (bits !== undefined) bl.addSubnet(a, Number(bits), type); else bl.addAddress(a, type);
  }
  return bl.check(addr, isIP(addr) === 6 ? 'ipv6' : 'ipv4');
};

export class KeyAuthError extends HttpError {}
const fail = (status: number, msg: string, code: string) => new KeyAuthError(status, msg, code);

let nonceSweep = 0;
async function loadKey(prefix: string) {
  const { rows: [k] } = await pool.query(
    `SELECT k.*, c.status AS client_status FROM client_api_keys k JOIN clients c ON c.id = k.client_id WHERE k.prefix = $1`, [prefix]);
  return k;
}
function usable(k: { revoked_at: Date | null; expires_at: Date; locked_until: Date | null; client_status: string } | undefined) {
  if (!k || k.revoked_at || new Date(k.expires_at) <= new Date() || k.client_status === 'closed') throw fail(401, 'Llave inválida, vencida o revocada', 'invalid_key');
  if (k.locked_until && new Date(k.locked_until) > new Date()) throw fail(423, 'Llave bloqueada temporalmente por firmas inválidas', 'key_locked');
}
async function badSignature(id: string) {
  await pool.query(
    `UPDATE client_api_keys SET failed_sigs = failed_sigs + 1,
            locked_until = CASE WHEN failed_sigs + 1 >= $2 THEN now() + interval '15 minutes' END WHERE id = $1`, [id, config.PORTAL_SIG_MAX_FAILS]);
}

/**
 * Firma Ed25519 por petición. Mensaje canónico:
 *   MÉTODO \n RUTA+QUERY \n TIMESTAMP(segundos) \n NONCE \n SHA256(cuerpo crudo, hex)
 */
export const canonical = (method: string, url: string, ts: string, nonce: string, body: string) =>
  `${method.toUpperCase()}\n${url}\n${ts}\n${nonce}\n${sha(body)}`;

export function verifyCanonicalSignature(publicKey: string, method: string, url: string, ts: string, nonce: string, signature: string, body: string) {
  try {
    return edVerify(null, Buffer.from(canonical(method, url, ts, nonce, body)),
      edKey(Buffer.from(publicKey, 'base64url')), Buffer.from(signature, 'base64url'));
  } catch {
    return false;
  }
}

export async function authenticateSigned(h: { key: string; ts?: string; nonce?: string; sig?: string }, req: { method: string; url: string; ip: string; rawBody?: string }) {
  if (!/^856k_[0-9a-f]{16}$/.test(h.key)) throw fail(401, 'Llave inválida', 'invalid_key');
  if (!h.ts || !h.nonce || !h.sig || !/^\d{10}$/.test(h.ts) || !/^[A-Za-z0-9_-]{16,64}$/.test(h.nonce)) {
    throw fail(401, 'Faltan x-856-timestamp, x-856-nonce (16-64) o x-856-signature', 'signature_required');
  }
  const k = await loadKey(h.key);
  usable(k);
  if (!ipAllowed(req.ip, k.ip_allowlist)) throw fail(403, 'IP no autorizada para esta llave', 'ip_not_allowed');
  if (Math.abs(Date.now() / 1000 - Number(h.ts)) > config.PORTAL_SIG_WINDOW_SEC) throw fail(401, 'Marca de tiempo fuera de la ventana permitida', 'stale_timestamp');
  const ok = verifyCanonicalSignature(k.public_key, req.method, req.url, h.ts, h.nonce, h.sig, req.rawBody ?? '');
  if (!ok) { await badSignature(k.id); throw fail(401, 'Firma inválida', 'invalid_signature'); }
  const n = await pool.query('INSERT INTO client_api_nonces (key_id, nonce) VALUES ($1,$2) ON CONFLICT DO NOTHING', [k.id, h.nonce]);
  if (!n.rowCount) throw fail(401, 'Nonce ya usado (posible repetición)', 'replay');
  if (++nonceSweep % 200 === 0) await pool.query(`DELETE FROM client_api_nonces WHERE created_at < now() - make_interval(secs => $1)`, [config.PORTAL_SIG_WINDOW_SEC * 2]);
  await pool.query('UPDATE client_api_keys SET last_used_at = now(), last_used_ip = $2, failed_sigs = 0 WHERE id = $1', [k.id, req.ip]);
  return { id: k.id, client_id: k.client_id, prefix: k.prefix, kind: k.kind, permissions: k.permissions } as ClientKey;
}

export async function authenticateReadToken(token: string, ip: string) {
  const m = READ_TOKEN_RE.exec(token);
  // El dígito verificador descarta errores de captura sin tocar la base
  if (!m || checksum(`856r_${m[1]}_${m[2]}`) !== m[3]) throw fail(401, 'Token inválido', 'invalid_key');
  const k = await loadKey(`856r_${m[1]}`);
  usable(k);
  const a = Buffer.from(sha(token)), b = Buffer.from(String(k.token_hash));
  if (a.length !== b.length || !timingSafeEqual(a, b)) { await badSignature(k.id); throw fail(401, 'Token inválido', 'invalid_key'); }
  if (!ipAllowed(ip, k.ip_allowlist)) throw fail(403, 'IP no autorizada para esta llave', 'ip_not_allowed');
  await pool.query('UPDATE client_api_keys SET last_used_at = now(), last_used_ip = $2 WHERE id = $1', [k.id, ip]);
  return { id: k.id, client_id: k.client_id, prefix: k.prefix, kind: k.kind, permissions: k.permissions } as ClientKey;
}

/** Primer admin de un cliente: lo invita la operación de 856 (alta de identidad, no una operación). */
export async function inviteFirstAdmin(clientId: string, email: string, operatorEmail: string) {
  const { rows: [n] } = await pool.query(`SELECT count(*)::int AS n FROM client_users WHERE client_id = $1 AND role = 'admin' AND active`, [clientId]);
  if (n.n > 0) throw new HttpError(409, 'El cliente ya tiene admin en el portal: él invita al resto', 'client_has_admin');
  return createInvite({ clientId, email, role: 'admin', createdBy: `operador:${operatorEmail}` });
}

/** Reenvío: revoca la invitación vigente y emite una nueva (mismo correo y rol) con enlace nuevo. */
export async function resendInvite(clientId: string, id: string, createdBy: string) {
  const { rows: [inv] } = await pool.query(
    'SELECT email, role FROM client_invites WHERE id = $1 AND client_id = $2 AND used_at IS NULL', [id, clientId]);
  if (!inv) throw new HttpError(404, 'Invitación no encontrada', 'not_found');
  return createInvite({ clientId, email: inv.email, role: inv.role, createdBy });
}

// ═════════════ Restablecimiento de contraseña (lo genera la tesorería; enlace de un solo uso) ═════════════
export async function createPasswordReset(clientId: string, userId: string, createdBy: string) {
  const { rows: [u] } = await pool.query(
    `SELECT u.id, u.email, c.status FROM client_users u JOIN clients c ON c.id = u.client_id WHERE u.id = $1 AND u.client_id = $2`, [userId, clientId]);
  if (!u) throw new HttpError(404, 'Usuario no encontrado', 'not_found');
  if (u.status === 'closed') throw new HttpError(409, 'Cliente cerrado', 'client_closed');
  await pool.query('UPDATE client_password_resets SET revoked_at = now() WHERE user_id = $1 AND used_at IS NULL AND revoked_at IS NULL', [userId]);
  const token = b64u(32);
  const expires_at = new Date(Date.now() + 24 * 3600_000);
  await pool.query('INSERT INTO client_password_resets (user_id, token_hash, created_by, expires_at) VALUES ($1,$2,$3,$4)',
    [userId, sha(token), createdBy, expires_at]);
  return { email: u.email, expires_at, link: `/portal/restablecer#${token}` };
}

async function openPasswordReset(token: string) {
  const { rows: [r] } = await pool.query(
    `SELECT r.id, r.user_id, r.created_by, u.client_id, u.email, c.name AS client_name, c.status AS client_status
       FROM client_password_resets r JOIN client_users u ON u.id = r.user_id JOIN clients c ON c.id = u.client_id
      WHERE r.token_hash = $1 AND r.used_at IS NULL AND r.revoked_at IS NULL AND r.expires_at > now()`, [sha(token)]);
  if (!r || r.client_status === 'closed') throw new HttpError(404, 'Enlace inválido, usado o vencido', 'invalid_reset');
  return r;
}
export async function lookupPasswordReset(token: string) {
  const r = await openPasswordReset(token);
  return { email: r.email, client_name: r.client_name };
}
export async function acceptPasswordReset(token: string, password: string) {
  if (password.length < PASSWORD_MIN) throw new HttpError(400, `La contraseña requiere al menos ${PASSWORD_MIN} caracteres`, 'weak_password');
  const r = await openPasswordReset(token);
  const used = await pool.query('UPDATE client_password_resets SET used_at = now() WHERE id = $1 AND used_at IS NULL RETURNING id', [r.id]);
  if (!used.rowCount) throw new HttpError(404, 'Enlace inválido, usado o vencido', 'invalid_reset');
  await pool.query('UPDATE client_users SET password_hash = $2, failed_attempts = 0, locked_until = NULL WHERE id = $1',
    [r.user_id, await hash(password, ARGON)]);
  await revokeUserSessions(r.user_id);
  return { ok: true, email: r.email, user_id: r.user_id, client_id: r.client_id };
}

/** Restablecimiento de 2FA desde la consola (tesorería): el usuario lo vuelve a activar al entrar. */
export async function resetTotpByOperator(clientId: string, userId: string) {
  const { rows: [t] } = await pool.query('SELECT id FROM client_users WHERE id = $1 AND client_id = $2', [userId, clientId]);
  if (!t) throw new HttpError(404, 'Usuario no encontrado', 'not_found');
  await clearTotp(userId);
  await revokeUserSessions(userId);
  return { ok: true };
}

export async function portalStatus(clientId: string) {
  const { rows: [r] } = await pool.query(
    `SELECT (SELECT count(*)::int FROM client_users WHERE client_id = $1 AND active) AS users,
            (SELECT count(*)::int FROM client_users WHERE client_id = $1 AND active AND role = 'admin') AS admins,
            (SELECT count(*)::int FROM client_invites WHERE client_id = $1 AND used_at IS NULL AND revoked_at IS NULL AND expires_at > now()) AS pending_invites,
            (SELECT count(*)::int FROM client_api_keys WHERE client_id = $1 AND revoked_at IS NULL AND expires_at > now()) AS active_keys`, [clientId]);
  return r;
}
