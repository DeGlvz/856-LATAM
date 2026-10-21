// Consola: configuración de cliente preparada por el ejecutivo y liberada por el tesorero (con 2FA).
// Ejecutivo/tesorero crean y envían; solo el tesorero libera o rechaza (ver TESORERO en auth/operators.ts).
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { audit, type Operator } from '../auth/operators.js';
import { HttpError } from '../idempotency.js';
import * as D from '../ledger/config-drafts.js';
import { treasurer2fa } from './fiat.js';

const uuid = z.string().uuid();
const parse = <S extends z.ZodTypeAny>(s: S, v: unknown): z.infer<S> => {
  const r = s.safeParse(v);
  if (!r.success) throw new HttpError(400, r.error.issues.map((i) => `${i.path.join('.') || 'cuerpo'}: ${i.message}`).join('; '), 'validation_error');
  return r.data;
};

const Create = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('whitelist'), address: z.string().max(80), network: z.string().max(40).optional(), label: z.string().trim().max(100).optional() }),
  z.object({ kind: z.literal('threshold'), asset_id: z.string().regex(/^[A-Z0-9-]{3,40}$/, 'activo inválido'),
    threshold: z.string().regex(/^[1-9]\d{0,77}$/, 'entero positivo en unidades base').nullable() }),
]);

function operator(req: FastifyRequest): Operator {
  const p = req.principal;
  if (p?.kind !== 'operator') throw new HttpError(403, 'Requiere sesión de ejecutivo o tesorero', 'session_required');
  return p.operator;
}

export async function configDraftRoutes(app: FastifyInstance) {
  app.get<{ Querystring: { status?: string } }>('/config-drafts', async (req) =>
    D.listDrafts({ status: parse(z.enum(['draft', 'submitted', 'released', 'rejected', 'cancelled']).optional(), req.query.status) }));
  app.get<{ Params: { id: string } }>('/clients/:id/config-drafts', async (req) =>
    D.listDrafts({ clientId: parse(uuid, req.params.id) }));

  app.post<{ Params: { id: string } }>('/clients/:id/config-drafts', async (req, reply) => {
    const op = operator(req);
    const clientId = parse(uuid, req.params.id);
    const d = await D.createDraft(op, clientId, parse(Create, req.body));
    await audit({ operator_id: op.id, actor: `operador:${op.email}`, action: 'config_draft_created', target: String(d.id), status: 201, ip: req.ip, client_id: clientId, metadata: { kind: d.kind } });
    return reply.code(201).send(d);
  });

  app.post<{ Params: { id: string } }>('/config-drafts/:id/submit', async (req) => {
    const op = operator(req);
    const d = await D.submitDraft(op, parse(uuid, req.params.id));
    await audit({ operator_id: op.id, actor: `operador:${op.email}`, action: 'config_draft_submitted', target: String(d.id), ip: req.ip, client_id: String(d.client_id) });
    return d;
  });

  app.post<{ Params: { id: string } }>('/config-drafts/:id/cancel', async (req) => {
    const op = operator(req);
    const d = await D.cancelDraft(op, parse(uuid, req.params.id));
    await audit({ operator_id: op.id, actor: `operador:${op.email}`, action: 'config_draft_cancelled', target: String(d.id), ip: req.ip, client_id: String(d.client_id) });
    return d;
  });

  app.post<{ Params: { id: string } }>('/config-drafts/:id/release', async (req) => {
    const b = parse(z.object({ code: z.string().regex(/^\d{6}$/, 'código de 6 dígitos') }), req.body ?? {});
    await treasurer2fa(req, b.code);
    const op = operator(req);
    const d = await D.releaseDraft(op, parse(uuid, req.params.id));
    await audit({ operator_id: op.id, actor: `operador:${op.email}`, action: 'config_draft_released', target: String(d.id), ip: req.ip, client_id: String(d.client_id),
      metadata: { kind: d.kind, created_by: d.created_by, applied_ref: d.applied_ref } });
    return d;
  });

  app.post<{ Params: { id: string } }>('/config-drafts/:id/reject', async (req) => {
    const b = parse(z.object({ reason: z.string().trim().min(5).max(500) }), req.body ?? {});
    const p = req.principal;
    if (p?.kind !== 'operator' || p.operator.role !== 'tesorero') throw new HttpError(403, 'Requiere rol tesorero', 'forbidden');
    const d = await D.rejectDraft(p.operator, parse(uuid, req.params.id), b.reason);
    await audit({ operator_id: p.operator.id, actor: `operador:${p.operator.email}`, action: 'config_draft_rejected', target: String(d.id), ip: req.ip, client_id: String(d.client_id), metadata: { reason: b.reason } });
    return d;
  });
}
