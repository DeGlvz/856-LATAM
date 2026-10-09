import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { idempotent } from '../idempotency.js';
import { LedgerError } from '../ledger/service.js';
import * as T from '../ledger/transfers.js';
import { getOrCreateDepositAddress } from '../ledger/deposit-addresses.js';
import { listSweeps } from '../ledger/sweeps.js';

const amount = z.string().regex(/^[1-9]\d{0,77}$/, 'entero positivo en unidades base');
const uuid = z.string().uuid();
const parse = <S extends z.ZodTypeAny>(s: S, v: unknown): z.infer<S> => {
  const r = s.safeParse(v);
  if (!r.success) throw new LedgerError(400, r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '), 'validation_error');
  return r.data;
};

const WithdrawalBody = z.object({
  client_id: uuid, asset_id: z.string(), to_address: z.string(), amount,
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export async function transferRoutes(app: FastifyInstance) {
  // Retiros on-chain: reserva inmediata; firma, envío y confirmaciones los hace el worker
  app.post('/withdrawals', async (req, reply) =>
    idempotent(req, reply, async (key) => ({ status: 202, body: await T.requestWithdrawal({ ...parse(WithdrawalBody, req.body), idempotency_key: key }) })));
  app.get<{ Querystring: { client_id?: string; status?: string; limit?: string } }>('/withdrawals', async (req) =>
    ({ withdrawals: await T.listWithdrawals({ ...req.query, limit: Number(req.query.limit ?? 100) }) }));
  app.get<{ Params: { id: string } }>('/withdrawals/:id', async (req) => T.getWithdrawal(parse(uuid, req.params.id)));
  app.post<{ Params: { id: string } }>('/withdrawals/:id/cancel', async (req) => T.cancelWithdrawal(parse(uuid, req.params.id)));

  // Depósitos: reportar un hash (o vía webhook de Alchemy); se acreditan al llegar a N confirmaciones
  app.post('/deposits/report', async (req, reply) => {
    const { tx_hash } = parse(z.object({ tx_hash: z.string() }), req.body);
    return reply.code(202).send(await T.detectDeposits(tx_hash, 'api'));
  });
  app.get<{ Querystring: { client_id?: string; status?: string; limit?: string } }>('/deposits', async (req) =>
    ({ deposits: await T.listDeposits({ ...req.query, limit: Number(req.query.limit ?? 100) }) }));

  // Dirección de depósito propia del cliente (derivada HD, registrada en el webhook)
  app.post<{ Params: { id: string } }>('/clients/:id/deposit-address', async (req, reply) => {
    const { rotate } = parse(z.object({ rotate: z.boolean().optional() }), req.body ?? {});
    return reply.code(201).send(await getOrCreateDepositAddress(parse(uuid, req.params.id), rotate ?? false));
  });
  app.get<{ Querystring: { limit?: string } }>('/sweeps', async (req) => ({ sweeps: await listSweeps(Number(req.query.limit ?? 100)) }));

  // Tesorería y operación
  app.get('/treasury/hot-wallet', async () => T.hotWalletStatus());
  app.post('/worker/tick', async (req) => T.workerTick(req.log));
}
