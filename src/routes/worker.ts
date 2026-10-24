import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { hasRole } from '../auth/operators.js';
import { stepUp } from '../auth/operator-admin.js';
import { LedgerError } from '../ledger/service.js';
import { WorkerPolicyInput } from '../ledger/worker-schedule.js';
import { runWorkerClient, saveWorkerPolicy, workerClient, workerClients } from '../ledger/worker.js';

const parse = <S extends z.ZodType>(schema: S, input: unknown): z.infer<S> => {
  const result = schema.safeParse(input);
  if (!result.success) throw new LedgerError(400, result.error.issues.map((i) => i.message).join('; '), 'validation_error');
  return result.data;
};
export function workerOperator(req: FastifyRequest) {
  const p = req.principal;
  if (p?.kind !== 'operator') throw new LedgerError(403, 'Solo sesiones internas pueden controlar el worker', 'operator_required');
  if (!hasRole(p.operator.role, 'ejecutivo')) throw new LedgerError(403, 'Requiere ejecutivo o tesorero', 'forbidden');
  if (!['GET', 'HEAD'].includes(req.method) && req.headers['x-856-console'] !== '1') {
    throw new LedgerError(403, 'Falta el header de consola', 'csrf');
  }
  return p.operator;
}
export async function workerRoutes(app: FastifyInstance) {
  app.addHook('onRequest', async (req) => { workerOperator(req); });
  app.get('/console/worker/clients', async (req) => {
    const q = parse(z.object({ search: z.string().trim().max(100).default(''), limit: z.coerce.number().int().min(1).max(200).default(100) }), req.query);
    return { clients: await workerClients(q.search, q.limit) };
  });
  app.get<{ Params: { clientId: string } }>('/console/worker/clients/:clientId', async (req) =>
    workerClient(parse(z.uuid(), req.params.clientId)));
  app.put<{ Params: { clientId: string } }>('/console/worker/clients/:clientId/policy', async (req) => {
    const id = parse(z.uuid(), req.params.clientId);
    const body = parse(z.object({ policy: WorkerPolicyInput, revision: z.number().int().min(0), code: z.string().regex(/^\d{6}$/) }).strict(), req.body);
    const op = workerOperator(req);
    await stepUp(op, body.code);
    return saveWorkerPolicy(id, body.policy, body.revision, op);
  });
  app.post<{ Params: { clientId: string } }>('/console/worker/clients/:clientId/run', async (req) => {
    const id = parse(z.uuid(), req.params.clientId);
    const body = parse(z.object({ request_id: z.uuid(), code: z.string().regex(/^\d{6}$/) }).strict(), req.body);
    const op = workerOperator(req);
    await stepUp(op, body.code);
    return runWorkerClient(id, body.request_id, op, req.log);
  });
}
