import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { idempotent } from '../idempotency.js';
import * as L from '../ledger/service.js';

const amount = z.string().regex(/^[1-9]\d{0,77}$/, 'entero positivo en unidades base');
const uuid = z.string().uuid();
const parse = <T extends z.ZodTypeAny>(s: T, v: unknown): z.infer<T> => {
  const r = s.safeParse(v);
  if (!r.success) throw new L.LedgerError(400, r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '), 'validation_error');
  return r.data;
};

const AssetBody = z.object({
  id: z.string().regex(/^[A-Z0-9-]{3,40}$/), symbol: z.string().min(1).max(12),
  chain: z.enum(['ethereum', 'tron', 'bitcoin', 'litecoin']), network: z.string().min(3),
  kind: z.enum(['native', 'erc20', 'trc20', 'utxo']), contract_address: z.string().nullish(),
  decimals: z.number().int().min(0).max(36),
});
const ClientBody = z.object({
  name: z.string().min(2).max(200), external_id: z.string().max(100).optional(),
  kind: z.enum(['corporate', 'fund', 'fintech', 'individual']).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(), assets: z.array(z.string()).max(50).optional(),
});
const WalletBody = z.object({
  client_id: uuid.nullish(), chain: z.enum(['ethereum', 'tron', 'bitcoin', 'litecoin']), network: z.string().min(3),
  address: z.string().min(20).max(120),
  purpose: z.enum(['master_hot', 'master_cold', 'deposit', 'withdrawal_whitelist']),
  custody_ref: z.string().max(200).optional(), derivation_path: z.string().max(100).optional(), label: z.string().max(100).optional(),
});
const EntryBody = z.object({
  kind: z.enum(['deposit', 'withdrawal', 'transfer', 'fee', 'conversion', 'netting', 'adjustment']),
  description: z.string().max(500).optional(), external_ref: z.string().max(200).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  postings: z.array(z.object({ account: z.string().min(3), direction: z.enum(['debit', 'credit']), amount })).min(2).max(100),
});
const TransferBody = z.object({
  from: z.string().min(3), to: z.string().min(3), amount,
  description: z.string().max(500).optional(), metadata: z.record(z.string(), z.unknown()).optional(),
});

export async function ledgerRoutes(app: FastifyInstance) {
  // Activos
  app.get('/assets', async () => ({ assets: await L.listAssets() }));
  app.post('/assets', async (req, reply) => reply.code(201).send(await L.createAsset(parse(AssetBody, req.body))));

  // Clientes y sus cuentas
  app.post('/clients', async (req, reply) =>
    idempotent(req, reply, async () => ({ status: 201, body: await L.createClient(parse(ClientBody, req.body)) })));
  app.get<{ Params: { id: string } }>('/clients/:id', async (req) => L.getClient(parse(uuid, req.params.id)));
  app.post<{ Params: { id: string } }>('/clients/:id/accounts', async (req, reply) => {
    const { asset_id } = parse(z.object({ asset_id: z.string() }), req.body);
    return reply.code(201).send(await L.openAccountForClient(parse(uuid, req.params.id), asset_id));
  });

  // Cuentas
  app.get<{ Params: { ref: string } }>('/accounts/:ref', async (req) => L.getAccount(req.params.ref));
  app.get<{ Params: { ref: string }; Querystring: { limit?: string; before?: string } }>(
    '/accounts/:ref/postings', async (req) => {
      const acc = await L.getAccount(req.params.ref);
      return L.listPostings(acc.id, Number(req.query.limit ?? 50), req.query.before);
    });

  // Wallets on-chain
  app.post('/wallets', async (req, reply) => reply.code(201).send(await L.registerWallet(parse(WalletBody, req.body))));
  app.get<{ Querystring: { client_id?: string; network?: string } }>('/wallets', async (req) =>
    ({ wallets: await L.listWallets(req.query) }));

  // Asientos contables (requieren Idempotency-Key)
  app.post('/entries', async (req, reply) =>
    idempotent(req, reply, async (key) => {
      const r = await L.postEntry({ ...parse(EntryBody, req.body), idempotency_key: key });
      return { status: 201, body: r.entry };
    }));
  app.get<{ Params: { id: string } }>('/entries/:id', async (req) => L.getEntry(parse(uuid, req.params.id)));

  // Transferencia interna entre cuentas (sin gas, instantánea)
  app.post('/internal-transfers', async (req, reply) =>
    idempotent(req, reply, async (key) => {
      const r = await L.internalTransfer({ ...parse(TransferBody, req.body), idempotency_key: key });
      return { status: 201, body: r.entry };
    }));
}
