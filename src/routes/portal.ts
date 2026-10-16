// API del portal de clientes (/v1/portal/*). Autenticación propia, aislada de la consola:
//   • sesión de usuario del cliente (cookie __Host-c856p + header anti-CSRF x-856-portal)
//   • llave Ed25519 firmada por petición (x-856-key, x-856-timestamp, x-856-nonce, x-856-signature)
//   • token de solo lectura (Authorization: Bearer 856r_…)
// Todo se filtra por req.portal.clientId; un recurso de otro cliente responde 404.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { config } from '../config.js';
import { pool } from '../db.js';
import { HttpError } from '../idempotency.js';
import { audit } from '../auth/operators.js';
import * as P from '../portal/identity.js';
import { ACCOUNT_KEY_ROUTES, portalAccountRoutes } from './portal-accounts.js';
import { EXIT_KEY_READ, EXIT_KEY_WRITE, portalExitRoutes } from './portal-exits.js';
import { OBLIGATION_KEY_READ, OBLIGATION_KEY_WRITE, portalObligationRoutes } from './portal-obligations.js';
import { FIAT_KEY_READ, FIAT_KEY_WRITE, portalFiatRoutes } from './portal-fiat.js';

const parse = <S extends z.ZodTypeAny>(s: S, v: unknown): z.infer<S> => {
  const r = s.safeParse(v);
  if (!r.success) throw new HttpError(400, r.error.issues.map((i) => `${i.path.join('.') || 'cuerpo'}: ${i.message}`).join('; '), 'validation_error');
  return r.data;
};
const uuid = z.string().uuid();
const code6 = z.string().regex(/^\d{6}$/, 'código de 6 dígitos');
const role = z.enum(['viewer', 'operator', 'approver', 'admin']);

// Rutas sin sesión
const PUBLIC = new Set(['/v1/portal/auth/login', '/v1/portal/auth/login/totp', '/v1/portal/invites/lookup', '/v1/portal/invites/accept']);
// Rutas que aceptan llave de API (fase 1: identidad; fase 2: lectura de saldos y cuentas); el resto exige sesión de usuario
const KEY_ROUTES = new Set(['GET /v1/portal/me', 'GET /v1/portal/ping', ...ACCOUNT_KEY_ROUTES, ...EXIT_KEY_READ, ...EXIT_KEY_WRITE,
  ...OBLIGATION_KEY_READ, ...OBLIGATION_KEY_WRITE, ...FIAT_KEY_READ, ...FIAT_KEY_WRITE]);
const KEY_WITHDRAW = new Set(EXIT_KEY_WRITE);
const KEY_TRADE = new Set([...OBLIGATION_KEY_WRITE, ...FIAT_KEY_WRITE]);
// Rutas permitidas a approver/admin mientras activan su 2FA obligatorio
const ENROLL_ROUTES = new Set(['GET /v1/portal/me', 'POST /v1/portal/auth/logout', 'POST /v1/portal/auth/totp/setup', 'POST /v1/portal/auth/totp/enable']);

export const userOf = (req: FastifyRequest) => {
  if (req.portal?.kind !== 'client_user') throw new HttpError(403, 'Requiere sesión de usuario del portal', 'session_required');
  return req.portal.user;
};
const requireRole = (req: FastifyRequest, need: P.ClientRole) => {
  const u = userOf(req);
  if (!P.roleAtLeast(u.role, need)) throw new HttpError(403, `Requiere rol ${need}`, 'forbidden');
  return u;
};
const actorOf = (req: FastifyRequest) =>
  req.portal?.kind === 'client_user' ? `portal:${req.portal.user.email}` : req.portal?.kind === 'client_key' ? `llave:${req.portal.key.prefix}` : 'anonimo';

const setCookie = (reply: FastifyReply, token: string, expires: Date) =>
  reply.setCookie(P.PORTAL_COOKIE, token, { httpOnly: true, secure: config.COOKIE_SECURE, sameSite: 'strict', path: '/', expires });
const clearCookie = (reply: FastifyReply) =>
  reply.clearCookie(P.PORTAL_COOKIE, { httpOnly: true, secure: config.COOKIE_SECURE, sameSite: 'strict', path: '/' });

export async function portalRoutes(app: FastifyInstance) {
  // La firma necesita el cuerpo crudo: la autenticación corre después del parseo
  app.addHook('preValidation', async (req) => {
    const path = req.url.split('?')[0];
    if (PUBLIC.has(path)) return;
    const route = `${req.method} ${req.routeOptions.url ?? path}`;
    const keyHeader = req.headers['x-856-key'];
    const bearer = req.headers.authorization;
    if (typeof keyHeader === 'string' || (typeof bearer === 'string' && bearer.startsWith('Bearer 856r_'))) {
      const key = typeof keyHeader === 'string'
        ? await P.authenticateSigned({
          key: keyHeader, ts: req.headers['x-856-timestamp'] as string, nonce: req.headers['x-856-nonce'] as string,
          sig: req.headers['x-856-signature'] as string,
        }, { method: req.method, url: req.url, ip: req.ip, rawBody: (req as unknown as { rawBody?: string }).rawBody })
        : await P.authenticateReadToken(bearer!.slice(7), req.ip);
      req.portal = { kind: 'client_key', clientId: key.client_id, key };
      if (!KEY_ROUTES.has(route)) throw new HttpError(403, 'Esta operación requiere sesión de un usuario del portal', 'session_required');
      if (req.method === 'GET' && !key.permissions.includes('read')) throw new HttpError(403, 'La llave no tiene permiso read', 'forbidden');
      if (KEY_WITHDRAW.has(route) && (key.kind !== 'ed25519' || !key.permissions.includes('withdraw'))) {
        throw new HttpError(403, 'La llave no tiene permiso withdraw', 'forbidden');
      }
      if (KEY_TRADE.has(route) && (key.kind !== 'ed25519' || !key.permissions.includes('trade'))) {
        throw new HttpError(403, 'La llave no tiene permiso trade', 'forbidden');
      }
      return;
    }
    const s = await P.sessionFromToken(req.cookies?.[P.PORTAL_COOKIE]);
    if (!s) throw new HttpError(401, 'No autorizado', 'session_required');
    req.portal = { kind: 'client_user', clientId: s.user.client_id, user: s.user, sessionId: s.sessionId };
    if (req.method !== 'GET' && req.method !== 'HEAD' && req.headers['x-856-portal'] !== '1') {
      throw new HttpError(403, 'Falta el header del portal', 'csrf');
    }
    if (P.roleNeeds2fa(s.user.role) && !s.user.totp_enabled && !ENROLL_ROUTES.has(route)) {
      throw new HttpError(403, 'Su rol exige activar el 2FA antes de continuar', 'totp_enrollment_required');
    }
  });

  // Bitácora: toda escritura del portal (y cualquier rechazo con identidad), con el cliente
  app.addHook('onResponse', async (req, reply) => {
    const p = req.portal;
    if (!p || (req.method === 'GET' && reply.statusCode < 400)) return;
    const route = req.routeOptions.url ?? req.url.split('?')[0];
    if (route.startsWith('/v1/portal/auth/login')) return; // se registran con más detalle en su ruta
    const reason = (req.body as { reason?: unknown } | undefined)?.reason;
    await audit({
      actor: actorOf(req), action: `PORTAL ${req.method} ${route}`, client_id: p.clientId, status: reply.statusCode, ip: req.ip,
      target: Object.values((req.params ?? {}) as Record<string, string>).join(',') || null,
      metadata: typeof reason === 'string' ? { reason: reason.slice(0, 300) } : {},
    }).catch((e) => req.log.error(e, 'audit_log'));
  });

  // ───────────── Acceso ─────────────
  const LoginBody = z.object({ email: z.string().email().max(200), password: z.string().min(1).max(200) });
  app.post('/auth/login', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req, reply) => {
    const b = parse(LoginBody, req.body);
    const r = await P.login(b.email, b.password, { ip: req.ip, ua: req.headers['user-agent'] });
    if (!r.ok) {
      await audit({ actor: `portal:${b.email.toLowerCase()}`, action: 'portal_login_failed', status: 401, ip: req.ip,
        client_id: (r as { user?: { client_id: string } }).user?.client_id ?? null, metadata: { reason: r.reason } });
      throw new HttpError(401, 'Credenciales inválidas o cuenta bloqueada temporalmente', 'invalid_credentials');
    }
    if (r.mfa) {
      await audit({ actor: `portal:${r.user.email}`, action: 'portal_login_mfa_challenge', status: 200, ip: req.ip, client_id: r.user.client_id });
      return { mfa_required: true, mfa_token: r.challenge };
    }
    await audit({ actor: `portal:${r.user.email}`, action: 'portal_login', status: 200, ip: req.ip, client_id: r.user.client_id });
    setCookie(reply, r.token, r.expires_at);
    return { user: r.user, totp_enrollment_required: P.roleNeeds2fa(r.user.role) && !r.user.totp_enabled };
  });

  const MfaBody = z.object({ mfa_token: z.string().min(20).max(100), code: code6.optional(), recovery_code: z.string().min(10).max(20).optional() })
    .refine((v) => !!v.code !== !!v.recovery_code, 'envíe code o recovery_code');
  app.post('/auth/login/totp', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req, reply) => {
    const b = parse(MfaBody, req.body);
    const r = await P.completeMfa(b.mfa_token, b, { ip: req.ip, ua: req.headers['user-agent'] });
    if (!r.ok) {
      await audit({ actor: r.user ? `portal:${r.user.email}` : 'anonimo', action: 'portal_login_mfa_failed', status: 401, ip: req.ip,
        client_id: r.user?.client_id ?? null, metadata: { reason: r.reason } });
      throw new HttpError(401, r.reason === 'bad_code' ? 'Código incorrecto o ya usado' : 'El acceso expiró: vuelva a iniciar sesión', r.reason);
    }
    await audit({ actor: `portal:${r.user.email}`, action: 'portal_login', status: 200, ip: req.ip, client_id: r.user.client_id,
      metadata: { mfa: true, recovery_code: r.recovery } });
    setCookie(reply, r.token, r.expires_at);
    return { user: r.user };
  });

  app.post('/auth/logout', async (req, reply) => {
    if (req.portal?.kind === 'client_user') await P.revokeSession(req.portal.sessionId);
    clearCookie(reply);
    return { ok: true };
  });

  // Identidad actual + datos públicos del propio cliente (nada interno de 856)
  app.get('/me', async (req) => {
    const p = req.portal!;
    const { rows: [c] } = await pool.query('SELECT id, name, kind, status FROM clients WHERE id = $1', [p.clientId]);
    return p.kind === 'client_user'
      ? { kind: 'user', user: p.user, client: c, totp_enrollment_required: P.roleNeeds2fa(p.user.role) && !p.user.totp_enabled }
      : { kind: 'key', key: { prefix: p.key.prefix, kind: p.key.kind, permissions: p.key.permissions }, client: c };
  });
  // Para probar integraciones firmadas
  app.get('/ping', async (req) => ({ ok: true, client_id: req.portal!.clientId, via: req.portal!.kind, server_time: Math.floor(Date.now() / 1000) }));

  // ───────────── 2FA propio ─────────────
  app.post('/auth/totp/setup', async (req) => P.totpSetup(userOf(req)));
  app.post('/auth/totp/enable', async (req) => P.totpEnable(userOf(req), parse(z.object({ code: code6 }), req.body).code));
  app.post('/auth/totp/disable', async (req) => P.totpDisable(userOf(req), parse(z.object({ code: code6 }), req.body).code));
  app.post('/auth/recovery-codes', async (req) => P.regenerateRecoveryCodes(userOf(req), parse(z.object({ code: code6 }), req.body).code));

  // ───────────── Invitaciones (públicas: el token es la credencial) ─────────────
  const Token = z.object({ token: z.string().min(40).max(60) });
  app.post('/invites/lookup', { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (req) => P.lookupInvite(parse(Token, req.body).token));
  app.post('/invites/accept', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req) => {
    const b = parse(Token.extend({ name: z.string().trim().min(2).max(120), password: z.string().min(1).max(200) }), req.body);
    const u = await P.acceptInvite(b.token, b.name, b.password);
    await audit({ actor: `portal:${u.email}`, action: 'portal_invite_accepted', status: 200, ip: req.ip, client_id: u.client_id, metadata: { role: u.role } });
    return u;
  });

  // ───────────── Usuarios del cliente (admin) ─────────────
  app.get('/users', async (req) => ({ users: await P.listUsers(requireRole(req, 'admin').client_id) }));
  app.get('/users/invites', async (req) => ({ invites: await P.listInvites(requireRole(req, 'admin').client_id) }));
  app.post('/users/invites', async (req, reply) => {
    const u = requireRole(req, 'admin');
    const b = parse(z.object({ email: z.string().email().max(200), role }), req.body);
    return reply.code(201).send(await P.createInvite({ clientId: u.client_id, email: b.email, role: b.role, createdBy: `portal:${u.email}` }));
  });
  app.post<{ Params: { id: string } }>('/users/invites/:id/revoke', async (req) =>
    P.revokeInvite(requireRole(req, 'admin').client_id, parse(uuid, req.params.id)));
  app.patch<{ Params: { id: string } }>('/users/:id', async (req) => {
    const u = requireRole(req, 'admin');
    const b = parse(z.object({ role: role.optional(), active: z.boolean().optional() }).refine((v) => v.role || v.active !== undefined, 'nada que cambiar'), req.body);
    return P.updateUser(u.client_id, u, parse(uuid, req.params.id), b);
  });
  app.post<{ Params: { id: string } }>('/users/:id/totp/reset', async (req) => {
    const u = requireRole(req, 'admin');
    parse(z.object({ reason: z.string().trim().min(5, 'Indique el motivo (mín. 5 caracteres)').max(300) }), req.body ?? {});
    return P.resetUserTotp(u.client_id, u, parse(uuid, req.params.id));
  });

  // ───────────── Llaves de API (admin con 2FA; alta y rotación confirmadas con código) ─────────────
  const stepUp = async (u: P.ClientUser, code: string | undefined) => {
    if (!code || !(await P.consumeTotp(u.id, code))) throw new HttpError(422, 'Confirme con un código 2FA vigente', 'bad_code');
  };
  const KeyBody = z.object({
    name: z.string().trim().min(2).max(80), kind: z.enum(['ed25519', 'read_token']),
    permissions: z.array(z.enum(['read', 'trade', 'withdraw'])).min(1).max(3).optional(),
    ip_allowlist: z.array(z.string().trim().min(2).max(50)).max(20).optional(),
    expires_days: z.number().int().min(1).max(365).optional(),
    public_key: z.string().max(60).optional(), challenge: z.string().max(60).optional(), proof: z.string().max(120).optional(),
    code: code6,
  });
  app.get('/keys', async (req) => ({ keys: await P.listKeys(requireRole(req, 'admin').client_id), max_days: config.PORTAL_KEY_MAX_DAYS }));
  app.post('/keys/challenge', async (req) => P.keyChallenge(requireRole(req, 'admin')));
  app.post('/keys', async (req, reply) => {
    const u = requireRole(req, 'admin');
    const b = parse(KeyBody, req.body);
    await stepUp(u, b.code);
    return reply.code(201).send(await P.createKey(u, b));
  });
  app.post<{ Params: { id: string } }>('/keys/:id/rotate', async (req) => {
    const u = requireRole(req, 'admin');
    const b = parse(KeyBody.omit({ name: true, kind: true }).extend({ name: z.string().trim().min(2).max(80).optional() }), req.body);
    await stepUp(u, b.code);
    return P.rotateKey(u, parse(uuid, req.params.id), b);
  });
  app.post<{ Params: { id: string } }>('/keys/:id/revoke', async (req) => P.revokeKey(requireRole(req, 'admin').client_id, parse(uuid, req.params.id)));

  // ───────────── Fase 2: inicio y cuentas ─────────────
  await app.register(portalAccountRoutes);
  // ───────────── Fase 3: lista blanca y salidas ─────────────
  await app.register(portalExitRoutes);
  await app.register(portalObligationRoutes);
  // ───────────── Fase F1: recibir euros ─────────────
  await app.register(portalFiatRoutes);
}
