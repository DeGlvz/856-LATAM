import { createHash, randomBytes } from 'node:crypto';
import { hash, verify } from '@node-rs/argon2';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { config } from '../config.js';
import { pool } from '../db.js';

export type Role = 'lectura' | 'operador' | 'tesorero';
export const ROLES: Role[] = ['lectura', 'operador', 'tesorero'];
const RANK: Record<Role, number> = { lectura: 0, operador: 1, tesorero: 2 };
export const hasRole = (have: Role, need: Role) => RANK[have] >= RANK[need];

export interface Operator { id: string; email: string; name: string; role: Role }
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
}) {
  await pool.query(
    `INSERT INTO audit_log (operator_id, actor, action, target, status, ip, metadata) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [a.operator_id ?? null, a.actor, a.action, a.target ?? null, a.status ?? null, a.ip ?? null, a.metadata ?? {}],
  );
}

export type LoginResult =
  | { ok: true; operator: Operator; token: string; expires_at: Date }
  | { ok: false; reason: 'unknown' | 'locked' | 'bad_password' | 'inactive'; operator_id?: string };

export async function login(email: string, password: string, meta: { ip?: string; ua?: string }): Promise<LoginResult> {
  const { rows: [o] } = await pool.query(
    `SELECT id, email, name, role, password_hash, active, locked_until FROM operators WHERE email = $1`,
    [email.trim().toLowerCase()],
  );
  if (!o) { await verify(await DUMMY, password).catch(() => false); return { ok: false, reason: 'unknown' }; }
  const valid = await verify(o.password_hash, password).catch(() => false);
  if (!o.active) return { ok: false, reason: 'inactive', operator_id: o.id };
  if (o.locked_until && new Date(o.locked_until) > new Date()) return { ok: false, reason: 'locked', operator_id: o.id };
  if (!valid) {
    await pool.query(
      `UPDATE operators SET failed_attempts = failed_attempts + 1,
              locked_until = CASE WHEN failed_attempts + 1 >= $2 THEN now() + make_interval(mins => $3) END
        WHERE id = $1`,
      [o.id, config.LOGIN_MAX_FAILS, config.LOGIN_LOCK_MIN]);
    return { ok: false, reason: 'bad_password', operator_id: o.id };
  }
  const token = randomBytes(32).toString('base64url');
  const expires_at = new Date(Date.now() + config.SESSION_TTL_MIN * 60_000);
  await pool.query(
    `INSERT INTO operator_sessions (token_hash, operator_id, ip, user_agent, expires_at) VALUES ($1,$2,$3,$4,$5)`,
    [sha(token), o.id, meta.ip ?? null, meta.ua?.slice(0, 300) ?? null, expires_at]);
  await pool.query(`UPDATE operators SET failed_attempts = 0, locked_until = NULL, last_login_at = now() WHERE id = $1`, [o.id]);
  return { ok: true, operator: { id: o.id, email: o.email, name: o.name, role: o.role }, token, expires_at };
}

// Valida la cookie: sesión vigente, no revocada, sin inactividad excesiva y operador activo
export async function sessionFromRequest(req: FastifyRequest): Promise<{ operator: Operator; sessionId: string } | null> {
  const token = req.cookies?.[COOKIE];
  if (!token || token.length > 100) return null;
  const { rows: [s] } = await pool.query(
    `SELECT s.id AS session_id, s.last_seen_at, o.id, o.email, o.name, o.role
       FROM operator_sessions s JOIN operators o ON o.id = s.operator_id
      WHERE s.token_hash = $1 AND s.revoked_at IS NULL AND s.expires_at > now()
        AND s.last_seen_at > now() - make_interval(mins => $2) AND o.active`,
    [sha(token), config.SESSION_IDLE_MIN]);
  if (!s) return null;
  // Renovar la marca de actividad como máximo una vez por minuto
  if (Date.now() - new Date(s.last_seen_at).getTime() > 60_000) {
    await pool.query('UPDATE operator_sessions SET last_seen_at = now() WHERE id = $1', [s.session_id]);
  }
  return { operator: { id: s.id, email: s.email, name: s.name, role: s.role }, sessionId: s.session_id };
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
  'POST /v1/assets', 'POST /v1/wallets', 'POST /v1/entries', 'POST /v1/internal-transfers', 'POST /v1/netting/runs',
]);
const CUALQUIERA = new Set(['POST /v1/auth/logout']);

export function requiredRole(method: string, route: string): Role {
  if (method === 'GET' || method === 'HEAD') return 'lectura';
  const k = `${method} ${route}`;
  if (CUALQUIERA.has(k)) return 'lectura';
  if (TESORERO.has(k)) return 'tesorero';
  return 'operador';
}
