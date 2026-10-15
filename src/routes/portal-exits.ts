// Portal de clientes — fase 3: lista blanca y salidas. Se registra dentro de portalRoutes (hereda autenticación,
// anti-CSRF, gate de 2FA y bitácora). El cliente origina; la tesorería de 856 valida y autoriza en la consola.
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { HttpError } from '../idempotency.js';
import { consumeTotp, roleAtLeast, type ClientUser } from '../portal/identity.js';
import * as X from '../portal/exits.js';
import { userOf } from './portal.js';

const parse = <S extends z.ZodTypeAny>(s: S, v: unknown): z.infer<S> => {
  const r = s.safeParse(v);
  if (!r.success) throw new HttpError(400, r.error.issues.map((i) => `${i.path.join('.') || 'cuerpo'}: ${i.message}`).join('; '), 'validation_error');
  return r.data;
};
const uuid = z.string().uuid();
const code6 = z.string().regex(/^\d{6}$/, 'código de 6 dígitos');
const amount = z.string().regex(/^[1-9]\d{0,77}$/, 'entero positivo en unidades base');
const assetId = z.string().regex(/^[A-Z0-9-]{3,40}$/, 'activo inválido');

// Llaves: lectura con permiso read; originar o cancelar salidas con permiso withdraw (solo Ed25519)
export const EXIT_KEY_READ = ['GET /v1/portal/whitelist', 'GET /v1/portal/exits', 'GET /v1/portal/exits/:id'];
export const EXIT_KEY_WRITE = ['POST /v1/portal/exits/simulate', 'POST /v1/portal/exits', 'POST /v1/portal/exits/:id/cancel'];

const stepUp = async (u: ClientUser, code: string) => {
  if (!(await consumeTotp(u.id, code))) throw new HttpError(422, 'Confirme con un código 2FA vigente', 'bad_code');
};

export async function portalExitRoutes(app: FastifyInstance) {
  // ── Lista blanca ──
  app.get('/whitelist', async (req) => X.listWhitelist(req.portal!.clientId, req.portal!.kind === 'client_user' ? req.portal!.user.id : undefined));
  app.post('/whitelist', async (req, reply) => {
    const b = parse(z.object({ address: z.string().min(10).max(80), label: z.string().trim().min(1).max(80).optional(), network: z.string().min(3).max(40).optional() }), req.body);
    return reply.code(201).send(await X.requestWhitelist(userOf(req), b));
  });
  app.post<{ Params: { id: string } }>('/whitelist/:id/approve', async (req) => {
    const u = userOf(req);
    if (!roleAtLeast(u.role, 'approver')) throw new HttpError(403, 'Requiere rol approver', 'forbidden');
    await stepUp(u, parse(z.object({ code: code6 }), req.body).code);
    return X.approveWhitelist(u, parse(uuid, req.params.id));
  });
  app.post<{ Params: { id: string } }>('/whitelist/:id/remove', async (req) => X.removeWhitelist(userOf(req), parse(uuid, req.params.id)));

  // ── Umbral de aprobación interna (admin) ──
  app.get('/settings/approval-thresholds', async (req) => X.listThresholds(req.portal!.clientId));
  app.put('/settings/approval-thresholds', async (req) => {
    const u = userOf(req);
    if (!roleAtLeast(u.role, 'admin')) throw new HttpError(403, 'Requiere rol admin', 'forbidden');
    const b = parse(z.object({ asset_id: assetId, threshold: amount.nullable(), code: code6 }), req.body);
    await stepUp(u, b.code);
    return X.setThreshold(u, b.asset_id, b.threshold);
  });

  // ── Salidas ──
  app.post('/exits/simulate', async (req, reply) => {
    const b = parse(z.object({ asset_id: assetId, whitelist_id: uuid, amount }), req.body);
    return reply.code(201).send(await X.simulate(req.portal!, b));
  });
  app.post('/exits', async (req, reply) => {
    const b = parse(z.object({ simulation_id: uuid }), req.body);
    return reply.code(201).send(await X.submit(req.portal!, b.simulation_id, req.ip));
  });
  app.get('/exits', async (req) => {
    const q = parse(z.object({
      state: z.enum(['client_approval', 'validation', 'authorized', 'sent', 'executed', 'closed']).optional(),
      limit: z.coerce.number().int().min(1).max(200).default(50), cursor: z.string().max(300).optional(),
    }), req.query);
    return X.listExits(req.portal!.clientId, q);
  });
  app.get<{ Params: { id: string } }>('/exits/:id', async (req) => X.getExit(req.portal!.clientId, parse(uuid, req.params.id)));
  app.post<{ Params: { id: string } }>('/exits/:id/approve', async (req) => {
    const u = userOf(req);
    if (!roleAtLeast(u.role, 'approver')) throw new HttpError(403, 'Requiere rol approver', 'forbidden');
    await stepUp(u, parse(z.object({ code: code6 }), req.body).code);
    return X.clientApprove(u, parse(uuid, req.params.id));
  });
  app.post<{ Params: { id: string } }>('/exits/:id/cancel', async (req) => X.clientCancel(req.portal!, parse(uuid, req.params.id)));
}
