import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { idempotent } from '../idempotency.js';
import { LedgerError } from '../ledger/service.js';
import * as T from '../ledger/transfers.js';
import { getOrCreateDepositAddress } from '../ledger/deposit-addresses.js';
import { listSweeps } from '../ledger/sweeps.js';
import { clientStatus } from '../ledger/clients.js';

const amount = z.string().regex(/^[1-9]\d{0,77}$/, 'entero positivo en unidades base');
const uuid = z.string().uuid();
const parse = <S extends z.ZodTypeAny>(s: S, v: unknown): z.infer<S> => {
  const r = s.safeParse(v);
  if (!r.success) throw new LedgerError(400, r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '), 'validation_error');
  return r.data;
};

const ListQuery = z.object({
  limit: z.coerce.number().int().min(1).max(1000).default(100), cursor: z.string().max(300).optional(),
  client_id: uuid.optional(), asset_id: z.string().max(40).optional(),
});

const WithdrawalBody = z.object({
  client_id: uuid, asset_id: z.string(), to_address: z.string(), amount,
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export async function transferRoutes(app: FastifyInstance) {
  // Retiros on-chain: reserva inmediata; firma, envío y confirmaciones los hace el worker
  app.post('/withdrawals', async (req, reply) =>
    idempotent(req, reply, async (key) => ({ status: 202, body: await T.requestWithdrawal({ ...parse(WithdrawalBody, req.body), idempotency_key: key }) })));
  app.get('/withdrawals', async (req) => {
    const q = parse(ListQuery.extend({ status: z.enum(['reserved', 'signed', 'broadcast', 'confirmed', 'failed', 'cancelled']).optional() }), req.query);
    const r = await T.listWithdrawals(q);
    return { withdrawals: r.items, next_cursor: r.next_cursor };
  });
  app.get<{ Params: { id: string } }>('/withdrawals/:id', async (req) => T.getWithdrawal(parse(uuid, req.params.id)));
  app.post<{ Params: { id: string } }>('/withdrawals/:id/cancel', async (req) => {
    const { reason } = parse(z.object({ reason: z.string().trim().min(3).max(300).optional() }), req.body ?? {});
    const p = req.principal;
    const who = p?.kind === 'operator' ? `cancelado por ${p.operator.email}` : 'cancelado por el cliente';
    return T.cancelWithdrawal(parse(uuid, req.params.id), reason ? `${who}: ${reason}` : who);
  });

  // Depósitos: reportar un hash (o vía webhook de Alchemy); se acreditan al llegar a N confirmaciones
  app.post('/deposits/report', async (req, reply) => {
    const { tx_hash } = parse(z.object({ tx_hash: z.string() }), req.body);
    return reply.code(202).send(await T.detectDeposits(tx_hash, 'api'));
  });
  app.get('/deposits', async (req) => {
    const q = parse(ListQuery.extend({ status: z.enum(['pending', 'credited', 'orphaned']).optional() }), req.query);
    const r = await T.listDeposits(q);
    return { deposits: r.items, next_cursor: r.next_cursor };
  });

  // Dirección de depósito propia del cliente (derivada HD, registrada en el webhook)
  app.post<{ Params: { id: string } }>('/clients/:id/deposit-address', async (req, reply) => {
    const { rotate } = parse(z.object({ rotate: z.boolean().optional() }), req.body ?? {});
    if ((await clientStatus(parse(uuid, req.params.id))) === 'closed') throw new LedgerError(409, 'Cliente cerrado', 'client_closed');
    return reply.code(201).send(await getOrCreateDepositAddress(parse(uuid, req.params.id), rotate ?? false));
  });
  app.get('/sweeps', async (req) => {
    const q = parse(z.object({
      limit: z.coerce.number().int().min(1).max(1000).default(100), cursor: z.string().max(300).optional(),
      status: z.enum(['signed', 'broadcast', 'confirmed', 'failed']).optional(),
      kind: z.enum(['gas_topup', 'sweep_token', 'sweep_native']).optional(),
    }), req.query);
    const r = await listSweeps(q);
    return { sweeps: r.items, next_cursor: r.next_cursor };
  });

  // Tesorería y operación
  app.get('/treasury/hot-wallet', async () => T.hotWalletStatus());
  app.post('/worker/tick', async (req) => T.workerTick(req.log));
}
