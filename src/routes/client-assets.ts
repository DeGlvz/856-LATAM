// Activos habilitados por cliente (consola). El Tesorero los cambia con 2FA; el Ejecutivo los solicita.
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { stepUp } from '../auth/operator-admin.js';
import { HttpError } from '../idempotency.js';
import * as CA from '../ledger/client-assets.js';

const uuid = z.string().uuid();
const assetId = z.string().regex(/^[A-Z0-9-]{3,40}$/, 'activo inválido');
const code6 = z.string().regex(/^\d{6}$/, 'código de 6 dígitos');
const parse = <S extends z.ZodTypeAny>(s: S, v: unknown): z.infer<S> => {
  const r = s.safeParse(v);
  if (!r.success) throw new HttpError(400, r.error.issues.map((i) => `${i.path.join('.') || 'cuerpo'}: ${i.message}`).join('; '), 'validation_error');
  return r.data;
};
const who = (req: FastifyRequest) => req.principal?.kind === 'operator'
  ? { email: req.principal.operator.email, id: req.principal.operator.id as string }
  : { email: `api:${req.principal?.kind === 'api' ? req.principal.keyId : '?'}`, id: null as string | null };
/** Con sesión de consola, confirmación 2FA del tesorero que actúa. */
const confirm = async (req: FastifyRequest, code?: string) => {
  if (req.principal?.kind === 'operator') await stepUp(req.principal.operator, code ?? '');
};

export async function clientAssetRoutes(app: FastifyInstance) {
  app.get<{ Params: { id: string } }>('/clients/:id/assets', async (req) => CA.listClientAssets(parse(uuid, req.params.id)));

  app.put<{ Params: { id: string } }>('/clients/:id/assets/bulk', async (req) => {
    const b = parse(z.object({
      asset_ids: z.array(assetId).min(1).max(100).refine((ids) => new Set(ids).size === ids.length, 'No repita activos'),
      status: z.enum(['enabled', 'exit_only', 'disabled']), code: code6.optional(),
    }), req.body);
    await confirm(req, b.code);
    return CA.setClientAssets(parse(uuid, req.params.id), b.asset_ids, b.status, who(req).email);
  });

  app.put<{ Params: { id: string; assetId: string } }>('/clients/:id/assets/:assetId', async (req) => {
    const b = parse(z.object({ status: z.enum(['enabled', 'exit_only', 'disabled']), code: code6.optional() }), req.body);
    await confirm(req, b.code);
    return CA.setClientAsset(parse(uuid, req.params.id), parse(assetId, req.params.assetId), b.status, who(req).email);
  });

  // Solicitud del ejecutivo (queda pendiente de un tesorero distinto)
  app.post<{ Params: { id: string } }>('/clients/:id/asset-requests', async (req, reply) => {
    const b = parse(z.object({ asset_id: assetId, action: z.enum(['enable', 'exit_only', 'disable']),
      reason: z.string().trim().min(5, 'Indique el motivo (mín. 5 caracteres)').max(300) }), req.body);
    const w = who(req);
    return reply.code(201).send(await CA.requestChange({ client_id: parse(uuid, req.params.id), ...b, by: w.email, operatorId: w.id }));
  });
  app.post<{ Params: { id: string } }>('/clients/:id/asset-requests/bulk', async (req, reply) => {
    const b = parse(z.object({
      asset_ids: z.array(assetId).min(1).max(100).refine((ids) => new Set(ids).size === ids.length, 'No repita activos'),
      action: z.enum(['enable', 'exit_only', 'disable']),
      reason: z.string().trim().min(5, 'Indique el motivo (mín. 5 caracteres)').max(300),
    }), req.body);
    const w = who(req);
    return reply.code(201).send(await CA.requestChanges({ client_id: parse(uuid, req.params.id), ...b, by: w.email, operatorId: w.id }));
  });
  app.get('/asset-requests', async (req) => CA.listRequests(parse(z.object({
    status: z.enum(['pending', 'approved', 'rejected']).optional(), client_id: uuid.optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50), cursor: z.string().max(300).optional(),
  }), req.query)));
  app.post<{ Params: { id: string } }>('/asset-requests/:id/approve', async (req) => {
    const b = parse(z.object({ code: code6.optional() }), req.body ?? {});
    await confirm(req, b.code);
    const w = who(req);
    return CA.decideRequest(parse(uuid, req.params.id), true, { email: w.email, id: w.id ?? '' });
  });
  app.post<{ Params: { id: string } }>('/asset-requests/:id/reject', async (req) => {
    const b = parse(z.object({ reason: z.string().trim().min(5, 'Indique el motivo (mín. 5 caracteres)').max(300) }), req.body ?? {});
    const w = who(req);
    return CA.decideRequest(parse(uuid, req.params.id), false, { email: w.email, id: w.id ?? '' }, b.reason);
  });
}
