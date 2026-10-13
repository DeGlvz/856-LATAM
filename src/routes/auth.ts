import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { pool } from '../db.js';
import { HttpError } from '../idempotency.js';
import {
  audit, clearSessionCookie, completeMfa, consumeTotp, login, revokeSession, setSessionCookie, type Operator,
} from '../auth/operators.js';
import { decryptSecret, encryptSecret, generateSecret, otpauthUrl, verifyCode } from '../auth/totp.js';

const LoginBody = z.object({ email: z.string().email().max(200), password: z.string().min(1).max(200) });
const MfaBody = z.object({ mfa_token: z.string().min(20).max(100), code: z.string().regex(/^\d{6}$/, 'código de 6 dígitos') });
const CodeBody = z.object({ code: z.string().regex(/^\d{6}$/, 'código de 6 dígitos') });
const ResetBody = z.object({ reason: z.string().trim().min(5, 'Indique el motivo (mín. 5 caracteres)').max(300) });
const uuid = z.string().uuid();

const parse = <S extends z.ZodTypeAny>(s: S, v: unknown): z.infer<S> => {
  const r = s.safeParse(v);
  if (!r.success) throw new HttpError(400, r.error.issues.map((i) => i.message).join('; '), 'validation_error');
  return r.data;
};
const me = (req: FastifyRequest): Operator => {
  const p = req.principal;
  if (p?.kind !== 'operator') throw new HttpError(403, 'Solo para sesiones de operador', 'operator_only');
  return p.operator;
};

// Sesión de operadores de la consola. La x-api-key nunca llega al navegador.
export async function authRoutes(app: FastifyInstance) {
  app.post('/auth/login', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req, reply) => {
    const p = LoginBody.safeParse(req.body);
    if (!p.success) throw new HttpError(400, 'Correo y contraseña requeridos', 'validation_error');
    const r = await login(p.data.email, p.data.password, { ip: req.ip, ua: req.headers['user-agent'] });
    if (!r.ok) {
      await audit({ operator_id: r.operator_id, actor: p.data.email.toLowerCase(), action: 'login_failed', status: 401, ip: req.ip, metadata: { reason: r.reason } });
      // Mismo mensaje para todo: no revela si el correo existe o está bloqueado
      throw new HttpError(401, 'Credenciales inválidas o cuenta bloqueada temporalmente', 'invalid_credentials');
    }
    if ('mfa_required' in r) {
      await audit({ operator_id: r.operator.id, actor: r.operator.email, action: 'login_mfa_challenge', status: 200, ip: req.ip });
      return { mfa_required: true, mfa_token: r.challenge, expires_at: r.expires_at };
    }
    await audit({ operator_id: r.operator.id, actor: r.operator.email, action: 'login', status: 200, ip: req.ip });
    setSessionCookie(reply, r.token, r.expires_at);
    return { operator: r.operator, expires_at: r.expires_at };
  });

  // Segundo paso: código TOTP
  app.post('/auth/login/totp', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req, reply) => {
    const b = parse(MfaBody, req.body);
    const r = await completeMfa(b.mfa_token, b.code, { ip: req.ip, ua: req.headers['user-agent'] });
    if (!r.ok) {
      await audit({ operator_id: r.operator_id, actor: r.email ?? 'anonimo', action: 'login_mfa_failed', status: 401, ip: req.ip, metadata: { reason: r.reason } });
      throw new HttpError(401, r.reason === 'bad_code' ? 'Código incorrecto o ya usado' : 'El acceso expiró: vuelva a iniciar sesión', r.reason);
    }
    await audit({ operator_id: r.operator.id, actor: r.operator.email, action: 'login', status: 200, ip: req.ip, metadata: { mfa: true } });
    setSessionCookie(reply, r.token, r.expires_at);
    return { operator: r.operator, expires_at: r.expires_at };
  });

  app.get('/auth/me', async (req) => ({ operator: me(req) }));

  app.post('/auth/logout', async (req, reply) => {
    const p = req.principal;
    if (p?.kind === 'operator') {
      await revokeSession(p.sessionId);
      await audit({ operator_id: p.operator.id, actor: p.operator.email, action: 'logout', status: 200, ip: req.ip });
    }
    clearSessionCookie(reply);
    return { ok: true };
  });

  // ───────────── Alta y baja del segundo factor (el propio operador) ─────────────
  app.post('/auth/totp/setup', async (req) => {
    const o = me(req);
    if (o.totp_enabled) throw new HttpError(409, 'El 2FA ya está activo; desactívelo antes de volver a darlo de alta', 'totp_already_enabled');
    const secret = generateSecret();
    await pool.query('UPDATE operators SET totp_pending_enc = $2 WHERE id = $1', [o.id, encryptSecret(secret)]);
    return { secret, otpauth_url: otpauthUrl(secret, o.email) };
  });

  app.post('/auth/totp/enable', async (req) => {
    const o = me(req);
    const { code } = parse(CodeBody, req.body);
    const { rows: [r] } = await pool.query('SELECT totp_pending_enc, totp_enabled_at FROM operators WHERE id = $1', [o.id]);
    if (r.totp_enabled_at) throw new HttpError(409, 'El 2FA ya está activo', 'totp_already_enabled');
    if (!r.totp_pending_enc) throw new HttpError(409, 'Primero genere el secreto (setup)', 'totp_setup_required');
    const secret = decryptSecret(r.totp_pending_enc);
    const step = verifyCode(secret, code, null);
    if (step == null) throw new HttpError(422, 'Código incorrecto: revise la hora del teléfono e intente con el siguiente', 'bad_code');
    await pool.query(
      `UPDATE operators SET totp_secret_enc = totp_pending_enc, totp_pending_enc = NULL, totp_enabled_at = now(), totp_last_step = $2
        WHERE id = $1`, [o.id, step]);
    await audit({ operator_id: o.id, actor: o.email, action: 'totp_enabled', status: 200, ip: req.ip });
    return { totp_enabled: true };
  });

  app.post('/auth/totp/disable', async (req) => {
    const o = me(req);
    const { code } = parse(CodeBody, req.body);
    if (!o.totp_enabled) throw new HttpError(409, 'El 2FA no está activo', 'totp_not_enabled');
    if ((await consumeTotp(o.id, code)) == null) throw new HttpError(422, 'Código incorrecto o ya usado', 'bad_code');
    await pool.query(
      'UPDATE operators SET totp_secret_enc = NULL, totp_pending_enc = NULL, totp_enabled_at = NULL, totp_last_step = NULL WHERE id = $1', [o.id]);
    await audit({ operator_id: o.id, actor: o.email, action: 'totp_disabled', status: 200, ip: req.ip });
    return { totp_enabled: false };
  });

  // ───────────── Operadores (tesorería) ─────────────
  app.get('/operators', async () => {
    const { rows } = await pool.query(
      `SELECT id, email, name, role, active, totp_enabled_at IS NOT NULL AS totp_enabled, totp_enabled_at,
              last_login_at, locked_until, created_at
         FROM operators ORDER BY role DESC, email`);
    return { operators: rows };
  });

  // Restablecer el 2FA de otro operador (teléfono perdido): borra su secreto y cierra sus sesiones
  app.post<{ Params: { id: string } }>('/operators/:id/totp/reset', async (req) => {
    const o = me(req);
    const id = parse(uuid, req.params.id);
    const { reason } = parse(ResetBody, req.body ?? {});
    if (id === o.id) throw new HttpError(409, 'No puede restablecer su propio 2FA: pídalo a otro tesorero', 'self_reset');
    const { rows: [t] } = await pool.query(
      `UPDATE operators SET totp_secret_enc = NULL, totp_pending_enc = NULL, totp_enabled_at = NULL, totp_last_step = NULL
        WHERE id = $1 RETURNING email`, [id]);
    if (!t) throw new HttpError(404, 'Operador no encontrado', 'not_found');
    await pool.query('UPDATE operator_sessions SET revoked_at = now() WHERE operator_id = $1 AND revoked_at IS NULL', [id]);
    await audit({ operator_id: o.id, actor: o.email, action: 'totp_reset', target: t.email, status: 200, ip: req.ip, metadata: { reason } });
    return { ok: true };
  });
}
