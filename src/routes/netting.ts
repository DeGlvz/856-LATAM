import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { idempotent } from '../idempotency.js';
import { LedgerError } from '../ledger/service.js';
import * as N from '../ledger/netting.js';
import { assertApprover, decider, requester } from '../ledger/approvals.js';

const amount = z.string().regex(/^[1-9]\d{0,77}$/, 'entero positivo en unidades base');
const uuid = z.string().uuid();
const ts = z.string().datetime({ offset: true });
const parse = <T extends z.ZodTypeAny>(s: T, v: unknown): z.infer<T> => {
  const r = s.safeParse(v);
  if (!r.success) throw new LedgerError(400, r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '), 'validation_error');
  return r.data;
};

// Quién hizo la acción: correo del operador (consola) o prefijo de la API key (integración)
const actor = (req: FastifyRequest) =>
  req.principal?.kind === 'operator' ? req.principal.operator.email : `api:${req.principal?.kind === 'api' ? req.principal.keyId : '?'}`;

const ObligationBody = z.object({
  debtor_id: uuid, creditor_id: uuid, asset_id: z.string(), amount,
  due_at: ts.optional(), external_ref: z.string().trim().max(200).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});
const ObligationQuery = z.object({
  client_id: uuid.optional(), status: z.enum(['open', 'settled', 'cancelled']).optional(), asset_id: z.string().optional(),
  external_ref: z.string().trim().min(1).max(200).optional(), from: ts.optional(), to: ts.optional(),
  netting_run_id: uuid.optional(), limit: z.coerce.number().int().min(1).max(1000).default(100), cursor: z.string().max(300).optional(),
});
const CancelBody = z.object({ reason: z.string().trim().min(5, 'Indique el motivo (mín. 5 caracteres)').max(500) });
const Scope = z.object({
  asset_id: z.string(), cutoff: ts.optional(),
  obligation_ids: z.array(uuid).min(1).max(10000).optional(),
});
const RunBody = Scope.extend({ expected_net_amount: z.string().regex(/^(0|[1-9]\d{0,77})$/).optional() });
const RunsQuery = z.object({
  asset_id: z.string().optional(), status: z.enum(['pending_approval', 'settled', 'rejected']).optional(), limit: z.coerce.number().int().min(1).max(200).default(50), cursor: z.string().max(300).optional(),
});

export async function nettingRoutes(app: FastifyInstance) {
  app.post('/obligations', async (req, reply) =>
    idempotent(req, reply, async () => ({ status: 201, body: await N.createObligation(parse(ObligationBody, req.body)) })));
  app.get('/obligations', async (req) => N.listObligations(parse(ObligationQuery, req.query)));
  app.post<{ Params: { id: string } }>('/obligations/:id/cancel', async (req) =>
    N.cancelObligation(parse(uuid, req.params.id), parse(CancelBody, req.body ?? {}).reason, actor(req)));

  // Simulación: posiciones netas, ahorro, faltantes y pagadores bloqueados, sin mover nada
  app.post('/netting/preview', async (req) => N.previewNetting(parse(Scope, req.body)));
  // Ejecución atómica (requiere Idempotency-Key). expected_net_amount: neto que se vio en la simulación
  // Con doble aprobación queda pendiente (202) hasta que otro tesorero la apruebe; sin ella se liquida al instante (201)
  app.post('/netting/runs', async (req, reply) =>
    idempotent(req, reply, async (key) => {
      const r = requester(req);
      const run = await N.runNetting({
        ...parse(RunBody, req.body), idempotency_key: key, created_by: actor(req),
        requested_by_operator: r.operatorId, needs_approval: r.needsApproval,
      });
      return { status: run.status === 'pending_approval' ? 202 : 201, body: run };
    }));
  app.post<{ Params: { id: string } }>('/netting/runs/:id/approve', async (req) => {
    const op = decider(req);
    const id = parse(uuid, req.params.id);
    const { code } = parse(z.object({ code: z.string().optional() }), req.body ?? {});
    const run = await N.getNettingRun(id);
    if (run.status !== 'pending_approval') throw new LedgerError(409, `La corrida no está pendiente (estado: ${run.status})`, 'not_pending');
    await assertApprover(op, run.requested_by_operator, code);
    return N.approveNettingRun(id, op);
  });
  app.post<{ Params: { id: string } }>('/netting/runs/:id/reject', async (req) => {
    const op = decider(req);
    const { reason } = parse(z.object({ reason: z.string().trim().min(5, 'Indique el motivo (mín. 5 caracteres)').max(300) }), req.body ?? {});
    return N.rejectNettingRun(parse(uuid, req.params.id), op.email, reason);
  });
  app.get('/netting/runs', async (req) => N.listNettingRuns(parse(RunsQuery, req.query)));
  app.get<{ Params: { id: string } }>('/netting/runs/:id', async (req) => N.getNettingRun(parse(uuid, req.params.id)));
}
