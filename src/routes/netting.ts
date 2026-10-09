import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { idempotent } from '../idempotency.js';
import { LedgerError } from '../ledger/service.js';
import * as N from '../ledger/netting.js';

const amount = z.string().regex(/^[1-9]\d{0,77}$/, 'entero positivo en unidades base');
const uuid = z.string().uuid();
const parse = <T extends z.ZodTypeAny>(s: T, v: unknown): z.infer<T> => {
  const r = s.safeParse(v);
  if (!r.success) throw new LedgerError(400, r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '), 'validation_error');
  return r.data;
};

const ObligationBody = z.object({
  debtor_id: uuid, creditor_id: uuid, asset_id: z.string(), amount,
  due_at: z.string().datetime({ offset: true }).optional(), external_ref: z.string().max(200).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});
const Scope = z.object({
  asset_id: z.string(), cutoff: z.string().datetime({ offset: true }).optional(),
  obligation_ids: z.array(uuid).min(1).max(10000).optional(),
});

export async function nettingRoutes(app: FastifyInstance) {
  app.post('/obligations', async (req, reply) =>
    idempotent(req, reply, async () => ({ status: 201, body: await N.createObligation(parse(ObligationBody, req.body)) })));
  app.get<{ Querystring: { client_id?: string; status?: string; asset_id?: string; limit?: string } }>(
    '/obligations', async (req) => ({ obligations: await N.listObligations({ ...req.query, limit: Number(req.query.limit ?? 100) }) }));
  app.post<{ Params: { id: string } }>('/obligations/:id/cancel', async (req) => N.cancelObligation(parse(uuid, req.params.id)));

  // Simulación: posiciones netas, ahorro y faltantes, sin mover nada
  app.post('/netting/preview', async (req) => N.previewNetting(parse(Scope, req.body)));
  // Ejecución atómica (requiere Idempotency-Key)
  app.post('/netting/runs', async (req, reply) =>
    idempotent(req, reply, async (key) => ({ status: 201, body: await N.runNetting({ ...parse(Scope, req.body), idempotency_key: key }) })));
  app.get<{ Params: { id: string } }>('/netting/runs/:id', async (req) => N.getNettingRun(parse(uuid, req.params.id)));
}
