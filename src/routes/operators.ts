// Consola: administración de operadores de 856 (invitaciones, rol, estado) y alertas del portal.
// Permisos por rol en src/auth/operators.ts; toda escritura exige además un código 2FA del tesorero (step-up).
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { HttpError } from '../idempotency.js';
import { audit, ROLES, type Operator, type Role, normalizeRole } from '../auth/operators.js';
import {
  acceptOperatorInvite, createOperatorInvite, listOperatorInvites, lookupOperatorInvite, portalAlerts,
  requireTotpActor, resendOperatorAccess, resendOperatorInvite, revokeOperatorInvite, stepUp, updateOperator,
} from '../auth/operator-admin.js';

const uuid = z.string().uuid();
const code = z.string({ error: 'code requerido (2FA)' }).regex(/^\d{6}$/, 'código 2FA de 6 dígitos');
const role = z.preprocess(normalizeRole, z.enum(ROLES as [Role, ...Role[]], { error: 'rol inválido (lectura|ejecutivo|tesorero)' }));
const InviteBody = z.object({ email: z.string().trim().email('correo inválido').max(200), role, code });
const RevokeBody = z.object({ code });
const PatchBody = z.object({ role: role.optional(), active: z.boolean().optional(), code })
  .refine((v) => v.role !== undefined || v.active !== undefined, 'Indique role o active');
const TokenBody = z.object({ token: z.string().min(20).max(100) });
const AcceptBody = TokenBody.extend({
  name: z.string().trim().min(2, 'nombre requerido').max(200),
  password: z.string().max(200),
});

const parse = <S extends z.ZodTypeAny>(s: S, v: unknown): z.infer<S> => {
  const r = s.safeParse(v ?? {});
  if (!r.success) throw new HttpError(400, r.error.issues.map((i) => i.message).join('; '), 'validation_error');
  return r.data;
};
/** Solo sesiones de operador (no API key) y con 2FA activo: se valida antes del cuerpo para orientar al usuario. */
const actor = (req: FastifyRequest): Operator => {
  const p = req.principal;
  if (p?.kind !== 'operator') throw new HttpError(403, 'Solo para sesiones de operador', 'operator_only');
  requireTotpActor(p.operator);
  return p.operator;
};

export async function operatorRoutes(app: FastifyInstance) {
  // ───────────── Invitaciones (tesorero + 2FA) ─────────────
  app.post('/operators/invites', async (req, reply) => {
    const o = actor(req);
    const b = parse(InviteBody, req.body);
    await stepUp(o, b.code);
    const inv = await createOperatorInvite(o, b);
    await audit({ operator_id: o.id, actor: o.email, action: 'operator_invite_created', target: inv.email, status: 201, ip: req.ip,
      metadata: { invite_id: inv.id, role: inv.role, expires_at: inv.expires_at } });
    return reply.code(201).send(inv);
  });

  app.get('/operators/invites', async () => ({ invites: await listOperatorInvites() }));

  app.post<{ Params: { id: string } }>('/operators/invites/:id/revoke', async (req) => {
    const o = actor(req);
    const id = parse(uuid, req.params.id);
    const b = parse(RevokeBody, req.body);
    await stepUp(o, b.code);
    const r = await revokeOperatorInvite(id);
    await audit({ operator_id: o.id, actor: o.email, action: 'operator_invite_revoked', target: r.email, status: 200, ip: req.ip,
      metadata: { invite_id: id, role: r.role } });
    return r;
  });

  app.post<{ Params: { id: string } }>('/operators/invites/:id/resend', async (req, reply) => {
    const o = actor(req);
    const id = parse(uuid, req.params.id);
    await stepUp(o, parse(RevokeBody, req.body).code);
    const inv = await resendOperatorInvite(o, id);
    await audit({ operator_id: o.id, actor: o.email, action: 'operator_invite_resent', target: inv.email, status: 201, ip: req.ip,
      metadata: { previous_invite_id: id, invite_id: inv.id, role: inv.role } });
    return reply.code(201).send(inv);
  });

  // Reenviar acceso a un operador existente (contraseña olvidada o nunca entró)
  app.post<{ Params: { id: string } }>('/operators/:id/access-link', async (req, reply) => {
    const o = actor(req);
    const id = parse(uuid, req.params.id);
    if (id === o.id) throw new HttpError(403, 'Pida a otro tesorero que le reenvíe el acceso', 'self_change');
    await stepUp(o, parse(RevokeBody, req.body).code);
    const inv = await resendOperatorAccess(o, id);
    await audit({ operator_id: o.id, actor: o.email, action: 'operator_access_resent', target: inv.email, status: 201, ip: req.ip,
      metadata: { operator: id, invite_id: inv.id } });
    return reply.code(201).send(inv);
  });

  // ───────────── Rol y estado (tesorero + 2FA) ─────────────
  app.patch<{ Params: { id: string } }>('/operators/:id', async (req) => {
    const o = actor(req);
    const id = parse(uuid, req.params.id);
    const b = parse(PatchBody, req.body);
    // Antes de consumir el código: un intento sobre sí mismo no gasta el 2FA
    if (id === o.id) throw new HttpError(403, 'No puede cambiar su propio rol o estado: pídalo a otro tesorero', 'self_change');
    await stepUp(o, b.code);
    const r = await updateOperator(o, id, { role: b.role, active: b.active });
    const base = { operator_id: o.id, actor: o.email, target: r.operator.email, status: 200, ip: req.ip };
    if (r.changes.role_changed) {
      await audit({ ...base, action: 'operator_role_changed', metadata: { id, from: r.changes.from.role, to: r.operator.role, sessions_revoked: r.sessions_revoked } });
    }
    if (r.changes.active_changed) {
      await audit({ ...base, action: r.operator.active ? 'operator_reactivated' : 'operator_deactivated',
        metadata: { id, sessions_revoked: r.changes.role_changed ? 0 : r.sessions_revoked } });
    }
    return { operator: r.operator, sessions_revoked: r.sessions_revoked };
  });

  // ───────────── Alta pública por enlace (sin sesión, con límite como el login) ─────────────
  const limited = { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } };
  app.post('/auth/invites/lookup', limited, async (req) => lookupOperatorInvite(parse(TokenBody, req.body).token));

  app.post('/auth/invites/accept', limited, async (req, reply) => {
    const b = parse(AcceptBody, req.body);
    const r = await acceptOperatorInvite(b.token, b.name, b.password);
    await audit({ operator_id: r.operator.id, actor: r.operator.email, action: 'operator_invite_accepted', target: r.operator.email,
      status: 201, ip: req.ip, metadata: { invite_id: r.invite_id, role: r.operator.role, invited_by: r.invited_by } });
    return reply.code(201).send({ id: r.operator.id, email: r.operator.email, name: r.operator.name, role: r.operator.role });
  });

  // ───────────── Alertas del portal (lectura+) ─────────────
  // Ruta estática: find-my-way la resuelve antes que GET /clients/:id
  app.get('/clients/portal-alerts', async () => portalAlerts());
}
