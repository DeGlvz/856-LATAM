import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { assertConsoleMayOriginate } from '../ledger/origin.js';
import { idempotent } from '../idempotency.js';
import * as L from '../ledger/service.js';
import { pool } from '../db.js';
import { allowedTransitions, assertAddress, clientStatus } from '../ledger/clients.js';
import { rollbackOnly, simulationFingerprint, simulationResult, type SimulationIssue } from '../simulation.js';

const amount = z.string().regex(/^[1-9]\d{0,77}$/, 'entero positivo en unidades base');
const uuid = z.string().uuid();
const parse = <T extends z.ZodTypeAny>(s: T, v: unknown): z.infer<T> => {
  const r = s.safeParse(v);
  if (!r.success) throw new L.LedgerError(400, r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '), 'validation_error');
  return r.data;
};

export const AssetBody = z.object({
  id: z.string().regex(/^[A-Z0-9-]{3,40}$/), symbol: z.string().min(1).max(12),
  chain: z.enum(['ethereum', 'tron', 'bitcoin', 'litecoin']), network: z.string().min(3),
  kind: z.enum(['native', 'erc20', 'trc20', 'utxo']), contract_address: z.string().nullish(),
  decimals: z.number().int().min(0).max(36),
});
export const ClientBody = z.object({
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
  const simulationRequested = (req: FastifyRequest) => req.headers['x-856-simulate'] === 'true';
  const sendIssues = (reply: FastifyReply, issues: SimulationIssue[]) => reply.code(422).send({ errors: issues });
  const schemaIssues = (issues: z.ZodIssue[]): SimulationIssue[] =>
    issues.map((i) => ({ fila: 1, campo: i.path.join('.') || 'payload', motivo: i.message }));
  const assetUnitsIssue = (symbol: string, decimals: number): SimulationIssue | null => {
    const upper = symbol.toUpperCase();
    const expected = upper === 'USDC' ? 6 : ['EURE', 'ETH'].includes(upper) ? 18 : null;
    return expected !== null && expected !== decimals
      ? { fila: 1, campo: 'decimals', motivo: `${upper} debe tener ${expected} decimales` }
      : null;
  };
  const simulationError = (e: unknown, field: string): SimulationIssue[] => {
    if (e instanceof L.LedgerError) return [{ fila: 1, campo: field, motivo: e.message }];
    const code = (e as { code?: string }).code;
    const databaseMessage: Record<string, string> = {
      '23505': 'El recurso ya existe', '23503': 'Referencia inexistente',
      '22P02': 'Formato inválido', '23514': 'Regla de negocio o saldo incumplido',
    };
    if (code && databaseMessage[code]) return [{ fila: 1, campo: field, motivo: databaseMessage[code] }];
    throw e;
  };

  // Activos
  app.get('/assets', async () => ({ assets: await L.listAssets() }));
  app.post('/assets', {
    preHandler: async (req, reply) => {
      if (!simulationRequested(req)) return;
      const parsed = AssetBody.safeParse(req.body);
      if (!parsed.success) return sendIssues(reply, schemaIssues(parsed.error.issues));
      const unitIssue = assetUnitsIssue(parsed.data.symbol, parsed.data.decimals);
      if (unitIssue) return sendIssues(reply, [unitIssue]);
      const fingerprint = simulationFingerprint({ route: 'POST /v1/assets', payload: parsed.data });
      try {
        await rollbackOnly((c) => L.createAsset(parsed.data, c));
      } catch (e) {
        return sendIssues(reply, simulationError(e, 'activo'));
      }
      return reply.code(200).send(simulationResult(fingerprint, { status: 'validated' }));
    },
  }, async (req, reply) => reply.code(201).send(await L.createAsset(parse(AssetBody, req.body))));
  // Clientes y sus cuentas
  app.post('/clients', {
    preHandler: async (req, reply) => {
      if (!simulationRequested(req)) return;
      const parsed = ClientBody.safeParse(req.body);
      if (!parsed.success) return sendIssues(reply, schemaIssues(parsed.error.issues));
      const fingerprint = simulationFingerprint({ route: 'POST /v1/clients', payload: parsed.data });
      try {
        const simulation = await rollbackOnly(async (c) => {
          if (parsed.data.assets?.length) {
            const { rows } = await c.query<{ id: string; symbol: string; decimals: number }>(
              'SELECT id, symbol, decimals FROM assets WHERE id = ANY($1) AND active', [parsed.data.assets]);
            const byId = new Map(rows.map((a) => [a.id, a]));
            const unitIssues = parsed.data.assets.flatMap((id, index) => {
              const asset = byId.get(id);
              const issue = asset && assetUnitsIssue(asset.symbol, asset.decimals);
              return issue ? [{ ...issue, fila: index + 1, campo: `assets.${index}` }] : [];
            });
            if (unitIssues.length) return { ok: false as const, issues: unitIssues };
          }
          return { ok: true as const, simulated: await L.createClient(parsed.data, c) };
        });
        if (!simulation.ok) return sendIssues(reply, simulation.issues);
        const simulated = simulation.simulated;
        return reply.code(200).send(simulationResult(fingerprint, {
          status: 'validated',
          simulated_client_id: simulated.id,
          accounts: simulated.accounts.map((a: { asset_id: string; code: string }) => ({ asset_id: a.asset_id, code: a.code })),
        }));
      } catch (e) {
        return sendIssues(reply, simulationError(e, 'assets'));
      }
    },
  }, async (req, reply) =>
    idempotent(req, reply, async () => ({ status: 201, body: await L.createClient(parse(ClientBody, req.body)) })));
  app.get<{ Params: { id: string } }>('/clients/:id', async (req) => {
    const c = await L.getClient(parse(uuid, req.params.id));
    return { ...c, allowed_transitions: allowedTransitions(c.status) };
  });
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
  app.post('/wallets', async (req, reply) => {
    const w = parse(WalletBody, req.body);
    if (w.purpose === 'withdrawal_whitelist') await assertConsoleMayOriginate(req, 'whitelist', w.client_id ?? null);
    assertAddress(w.chain, w.address);
    if (w.client_id && (await clientStatus(w.client_id)) === 'closed') throw new L.LedgerError(409, 'Cliente cerrado', 'client_closed');
    return reply.code(201).send(await L.registerWallet(w));
  });
  app.get<{ Querystring: { client_id?: string; network?: string } }>('/wallets', async (req) =>
    ({ wallets: await L.listWallets(req.query) }));

  // Asientos contables (requieren Idempotency-Key)
  app.post('/entries', {
    preHandler: async (req, reply) => {
      if (!simulationRequested(req)) return;
      const parsed = EntryBody.safeParse(req.body);
      if (!parsed.success) return sendIssues(reply, schemaIssues(parsed.error.issues));
      const fingerprint = simulationFingerprint({ route: 'POST /v1/entries', payload: parsed.data });
      try {
        const validation = await rollbackOnly(async (c) => {
          const refs = [...new Set(parsed.data.postings.map((p) => p.account))];
          const { rows } = await c.query<{ symbol: string; decimals: number }>(
            `SELECT DISTINCT s.symbol, s.decimals FROM accounts a JOIN assets s ON s.id = a.asset_id
              WHERE a.id::text = ANY($1) OR a.code = ANY($1)`, [refs]);
          const unitIssues = rows.flatMap((asset) => {
            const issue = assetUnitsIssue(asset.symbol, asset.decimals);
            return issue ? [{ ...issue, campo: 'activo' }] : [];
          });
          if (unitIssues.length) return { valid: false as const, issues: unitIssues };
          await L.postEntryIn(c, parsed.data);
          return { valid: true as const };
        });
        if (!validation.valid) return sendIssues(reply, validation.issues);
      } catch (e) {
        return sendIssues(reply, simulationError(e, 'partidas'));
      }
      return reply.code(200).send(simulationResult(fingerprint, { status: 'validated' }));
    },
  }, async (req, reply) =>
    idempotent(req, reply, async (key) => {
      const r = await L.postEntry({ ...parse(EntryBody, req.body), idempotency_key: key });
      return { status: 201, body: r.entry };
    }));
  app.get<{ Params: { id: string } }>('/entries/:id', async (req) => L.getEntry(parse(uuid, req.params.id)));

  // Transferencia interna entre cuentas (sin gas, instantánea)
  app.post('/internal-transfers', async (req, reply) => {
    await assertConsoleMayOriginate(req, 'internal_transfer', null);
    return idempotent(req, reply, async (key) => {
      const r = await L.internalTransfer({ ...parse(TransferBody, req.body), idempotency_key: key });
      return { status: 201, body: r.entry };
    });
  });
}
