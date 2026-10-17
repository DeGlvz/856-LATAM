import { createHash, randomBytes } from 'node:crypto';
import { hash, verify } from '@node-rs/argon2';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { config } from '../config.js';
import { pool } from '../db.js';
import { decryptSecret, verifyCode } from './totp.js';

// ejecutivo = Ejecutivo de cuenta (antes "operador"): atención a clientes; tesorero = superusuario
export type Role = 'lectura' | 'ejecutivo' | 'tesorero';
export const ROLES: Role[] = ['lectura', 'ejecutivo', 'tesorero'];
const RANK: Record<Role, number> = { lectura: 0, ejecutivo: 1, tesorero: 2 };
/** Acepta el nombre anterior del rol ("operador") por compatibilidad con scripts e integraciones. */
export const normalizeRole = (r: unknown) => (r === 'operador' ? 'ejecutivo' : r);
export const hasRole = (have: Role, need: Role) => RANK[have] >= RANK[need];

export interface Operator { id: string; email: string; name: string; role: Role; totp_enabled: boolean }
export type Principal = { kind: 'api'; keyId: string } | { kind: 'operator'; operator: Operator; sessionId: string };

declare module 'fastify' {
  interface FastifyRequest { principal?: Principal }
}

// argon2id (parámetros OWASP: 19 MiB, 2 iteraciones)
const ARGON = { memoryCost: 19456, timeCost: 2, parallelism: 1 };
export const hashPassword = (pw: string) => hash(pw, ARGON);
// Hash señuelo: el tiempo de respuesta no revela si el correo existe
const DUMMY = hashPassword(randomBytes(16).toString('hex'));

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
export const COOKIE = config.COOKIE_SECURE ? '__Host-c856' : 'c856';
export const PASSWORD_MIN = 12;

export async function createOperator(i: { email: string; name: string; password: string; role: Role }) {
  if (i.password.length < PASSWORD_MIN) throw new Error(`La contraseña requiere al menos ${PASSWORD_MIN} caracteres`);
  if (!ROLES.includes(i.role)) throw new Error(`Rol inválido: ${i.role}`);
  const { rows: [o] } = await pool.query(
    `INSERT INTO operators (email, name, password_hash, role) VALUES ($1,$2,$3,$4) RETURNING id, email, name, role`,
    [i.email.trim().toLowerCase(), i.name.trim(), await hashPassword(i.password), i.role],
  );
  return o as Operator;
}

// Primer tesorero desde variables de entorno, solo si no existe ningún operador
export async function bootstrapOperator(log: { info: (m: string) => void; warn: (m: string) => void }) {
  const { CONSOLE_BOOTSTRAP_EMAIL: email, CONSOLE_BOOTSTRAP_PASSWORD: password } = config;
  if (!email || !password) return;
  const { rows: [{ n }] } = await pool.query<{ n: string }>('SELECT count(*) AS n FROM operators');
  if (n !== '0') {
    log.warn('CONSOLE_BOOTSTRAP_PASSWORD sigue definida y ya hay operadores: elimínela de las variables');
    return;
  }
  await createOperator({ email, name: email.split('@')[0], password, role: 'tesorero' });
  await audit({ actor: 'sistema', action: 'operator_bootstrap', target: email.toLowerCase() });
  log.warn(`Operador inicial (tesorero) creado: ${email}. Elimine CONSOLE_BOOTSTRAP_PASSWORD de las variables`);
}

export async function audit(a: {
  operator_id?: string | null; actor: string; action: string; target?: string | null; status?: number; ip?: string; metadata?: Record<string, unknown>;
  client_id?: string | null;
}) {
  await pool.query(
    `INSERT INTO audit_log (operator_id, actor, action, target, status, ip, metadata, client_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [a.operator_id ?? null, a.actor, a.action, a.target ?? null, a.status ?? null, a.ip ?? null, a.metadata ?? {}, a.client_id ?? null],
  );
}

export type LoginResult =
  | { ok: true; operator: Operator; token: string; expires_at: Date }
  | { ok: true; mfa_required: true; operator: Operator; challenge: string; expires_at: Date }
  | { ok: false; reason: 'unknown' | 'locked' | 'bad_password' | 'inactive'; operator_id?: string };

const MFA_TTL_MS = 5 * 60_000;
const MFA_MAX_ATTEMPTS = 5;

async function registerFailure(operatorId: string) {
  await pool.query(
    `UPDATE operators SET failed_attempts = failed_attempts + 1,
            locked_until = CASE WHEN failed_attempts + 1 >= $2 THEN now() + make_interval(mins => $3) END
      WHERE id = $1`,
    [operatorId, config.LOGIN_MAX_FAILS, config.LOGIN_LOCK_MIN]);
}

async function createSession(operatorId: string, meta: { ip?: string; ua?: string }) {
  const token = randomBytes(32).toString('base64url');
  const expires_at = new Date(Date.now() + config.SESSION_TTL_MIN * 60_000);
  await pool.query(
    `INSERT INTO operator_sessions (token_hash, operator_id, ip, user_agent, expires_at) VALUES ($1,$2,$3,$4,$5)`,
    [sha(token), operatorId, meta.ip ?? null, meta.ua?.slice(0, 300) ?? null, expires_at]);
  await pool.query(`UPDATE operators SET failed_attempts = 0, locked_until = NULL, last_login_at = now() WHERE id = $1`, [operatorId]);
  return { token, expires_at };
}

export async function login(email: string, password: string, meta: { ip?: string; ua?: string }): Promise<LoginResult> {
  const { rows: [o] } = await pool.query(
    `SELECT id, email, name, role, password_hash, active, locked_until, totp_enabled_at IS NOT NULL AS totp_enabled
       FROM operators WHERE email = $1`,
    [email.trim().toLowerCase()],
  );
  if (!o) { await verify(await DUMMY, password).catch(() => false); return { ok: false, reason: 'unknown' }; }
  const valid = await verify(o.password_hash, password).catch(() => false);
  if (!o.active) return { ok: false, reason: 'inactive', operator_id: o.id };
  if (o.locked_until && new Date(o.locked_until) > new Date()) return { ok: false, reason: 'locked', operator_id: o.id };
  if (!valid) { await registerFailure(o.id); return { ok: false, reason: 'bad_password', operator_id: o.id }; }
  const operator: Operator = { id: o.id, email: o.email, name: o.name, role: o.role, totp_enabled: o.totp_enabled };
  // Con 2FA activo, la contraseña solo abre un reto de 5 minutos que se canjea con el código
  if (o.totp_enabled) {
    const challenge = randomBytes(32).toString('base64url');
    const expires_at = new Date(Date.now() + MFA_TTL_MS);
    await pool.query(
      `INSERT INTO operator_mfa_challenges (token_hash, operator_id, ip, user_agent, expires_at) VALUES ($1,$2,$3,$4,$5)`,
      [sha(challenge), o.id, meta.ip ?? null, meta.ua?.slice(0, 300) ?? null, expires_at]);
    return { ok: true, mfa_required: true, operator, challenge, expires_at };
  }
  const s = await createSession(o.id, meta);
  return { ok: true, operator, ...s };
}

export type MfaResult =
  | { ok: true; operator: Operator; token: string; expires_at: Date }
  | { ok: false; reason: 'invalid_challenge' | 'bad_code' | 'locked'; operator_id?: string; email?: string };

/** Segundo paso del login: canjea el reto con un código TOTP vigente y no usado. */
export async function completeMfa(challenge: string, code: string, meta: { ip?: string; ua?: string }): Promise<MfaResult> {
  const { rows: [ch] } = await pool.query(
    `SELECT c.token_hash, c.attempts, o.id, o.email, o.name, o.role, o.active, o.locked_until, o.totp_secret_enc, o.totp_last_step
       FROM operator_mfa_challenges c JOIN operators o ON o.id = c.operator_id
      WHERE c.token_hash = $1 AND c.used_at IS NULL AND c.expires_at > now()`, [sha(challenge)]);
  if (!ch || !ch.active || !ch.totp_secret_enc || ch.attempts >= MFA_MAX_ATTEMPTS) return { ok: false, reason: 'invalid_challenge', operator_id: ch?.id, email: ch?.email };
  if (ch.locked_until && new Date(ch.locked_until) > new Date()) return { ok: false, reason: 'locked', operator_id: ch.id, email: ch.email };
  const step = await consumeTotp(ch.id, code);
  if (step == null) {
    await pool.query('UPDATE operator_mfa_challenges SET attempts = attempts + 1 WHERE token_hash = $1', [ch.token_hash]);
    await registerFailure(ch.id);
    return { ok: false, reason: 'bad_code', operator_id: ch.id, email: ch.email };
  }
  await pool.query('UPDATE operator_mfa_challenges SET used_at = now() WHERE token_hash = $1', [ch.token_hash]);
  const s = await createSession(ch.id, meta);
  return { ok: true, operator: { id: ch.id, email: ch.email, name: ch.name, role: ch.role, totp_enabled: true }, ...s };
}

/**
 * Verifica un código TOTP del operador y lo marca como usado (un código no sirve dos veces).
 * Devuelve el paso aceptado o null. Atómico: dos peticiones con el mismo código no pasan ambas.
 */
export async function consumeTotp(operatorId: string, code: string): Promise<number | null> {
  const { rows: [o] } = await pool.query('SELECT totp_secret_enc, totp_last_step FROM operators WHERE id = $1', [operatorId]);
  if (!o?.totp_secret_enc) return null;
  const step = verifyCode(decryptSecret(o.totp_secret_enc), code, o.totp_last_step == null ? null : Number(o.totp_last_step));
  if (step == null) return null;
  const r = await pool.query(
    'UPDATE operators SET totp_last_step = $2 WHERE id = $1 AND (totp_last_step IS NULL OR totp_last_step < $2)', [operatorId, step]);
  return r.rowCount ? step : null;
}

// Valida la cookie: sesión vigente, no revocada, sin inactividad excesiva y operador activo
export async function sessionFromRequest(req: FastifyRequest): Promise<{ operator: Operator; sessionId: string } | null> {
  const token = req.cookies?.[COOKIE];
  if (!token || token.length > 100) return null;
  const { rows: [s] } = await pool.query(
    `SELECT s.id AS session_id, s.last_seen_at, o.id, o.email, o.name, o.role, o.totp_enabled_at IS NOT NULL AS totp_enabled
       FROM operator_sessions s JOIN operators o ON o.id = s.operator_id
      WHERE s.token_hash = $1 AND s.revoked_at IS NULL AND s.expires_at > now()
        AND s.last_seen_at > now() - make_interval(mins => $2) AND o.active`,
    [sha(token), config.SESSION_IDLE_MIN]);
  if (!s) return null;
  // Renovar la marca de actividad como máximo una vez por minuto
  if (Date.now() - new Date(s.last_seen_at).getTime() > 60_000) {
    await pool.query('UPDATE operator_sessions SET last_seen_at = now() WHERE id = $1', [s.session_id]);
  }
  return { operator: { id: s.id, email: s.email, name: s.name, role: s.role, totp_enabled: s.totp_enabled }, sessionId: s.session_id };
}

export async function revokeSession(sessionId: string) {
  await pool.query('UPDATE operator_sessions SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL', [sessionId]);
}

export function setSessionCookie(reply: FastifyReply, token: string, expires: Date) {
  reply.setCookie(COOKIE, token, { httpOnly: true, secure: config.COOKIE_SECURE, sameSite: 'strict', path: '/', expires });
}
export function clearSessionCookie(reply: FastifyReply) {
  reply.clearCookie(COOKIE, { httpOnly: true, secure: config.COOKIE_SECURE, sameSite: 'strict', path: '/' });
}

// ───────────── Permisos por rol ─────────────
// Lectura: solo consulta. Operador: altas y reportes. Tesorero: todo lo que mueve valor o toca tesorería.
const TESORERO = new Set([
  'POST /v1/withdrawals', 'POST /v1/withdrawals/:id/cancel', 'POST /v1/worker/tick',
  'POST /v1/assets', 'POST /v1/wallets', 'PATCH /v1/wallets/:id', 'POST /v1/entries', 'POST /v1/internal-transfers', 'POST /v1/netting/runs',
  'POST /v1/withdrawals/:id/approve', 'POST /v1/withdrawals/:id/reject', 'POST /v1/netting/runs/:id/approve', 'POST /v1/netting/runs/:id/reject',
  'POST /v1/operators/:id/totp/reset', 'POST /v1/withdrawals/:id/bump', 'POST /v1/sweeps/:id/bump',
  'POST /v1/clients/:id/portal-invite', 'PATCH /v1/assets/:id',
  'POST /v1/operators/invites', 'POST /v1/operators/invites/:id/revoke', 'PATCH /v1/operators/:id',
  // Multi-red: activos habilitados por cliente y depósitos en revisión
  'PUT /v1/clients/:id/assets/:assetId', 'POST /v1/asset-requests/:id/approve', 'POST /v1/asset-requests/:id/reject',
  'POST /v1/deposits/:id/release',
  // Fase F1: entrada de fiat
  'POST /v1/console/fiat/setup', 'POST /v1/console/fiat/poll', 'POST /v1/console/fiat/deposits/:id/release',
  'POST /v1/console/fiat/deposits/:id/reject', 'POST /v1/console/fiat/simulate', 'POST /v1/console/fiat/simulate/:orderId/process',
  // Registro de gas en el libro
  'POST /v1/gas-fundings',
]);
// Consultas restringidas: la bitácora (IPs, intentos) y la lista de operadores solo para tesorería
const GET_TESORERO = new Set(['GET /v1/audit', 'GET /v1/audit/actions', 'GET /v1/operators', 'GET /v1/operators/invites']);
// POST que solo consultan (no escriben): basta con rol lectura
const CUALQUIERA = new Set([
  'POST /v1/auth/logout', 'POST /v1/netting/preview',
  'POST /v1/auth/totp/setup', 'POST /v1/auth/totp/enable', 'POST /v1/auth/totp/disable',
]);

export function requiredRole(method: string, route: string): Role {
  const k = `${method} ${route}`;
  if (method === 'GET' || method === 'HEAD') return GET_TESORERO.has(k) ? 'tesorero' : 'lectura';
  if (CUALQUIERA.has(k)) return 'lectura';
  if (TESORERO.has(k)) return 'tesorero';
  return 'ejecutivo';
}
