// Portal de clientes — fase 2 (Inicio y cuentas). Se registra dentro de portalRoutes: hereda autenticación,
// anti-CSRF, gate de 2FA y bitácora. Lectura: cualquier rol o llave con permiso read (ver KEY_ROUTES).
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { HttpError } from '../idempotency.js';
import { roleAtLeast } from '../portal/identity.js';
import * as A from '../portal/accounts.js';
import { myAssets } from '../ledger/client-assets.js';

const parse = <S extends z.ZodTypeAny>(s: S, v: unknown): z.infer<S> => {
  const r = s.safeParse(v);
  if (!r.success) throw new HttpError(400, r.error.issues.map((i) => `${i.path.join('.') || 'cuerpo'}: ${i.message}`).join('; '), 'validation_error');
  return r.data;
};
const assetId = z.string().regex(/^[A-Z0-9-]{3,40}$/, 'activo inválido');
const date = z.string().max(40).refine((v) => /^\d{4}-\d{2}-\d{2}/.test(v) && !Number.isNaN(Date.parse(v)), 'fecha ISO 8601');
const Range = z.object({ from: date.optional(), to: date.optional() });
const cursor = z.string().max(300).optional();

const clientOf = (req: FastifyRequest) => req.portal!.clientId;
const sendCsv = (reply: FastifyReply, r: { filename: string; csv: string }) =>
  reply.header('content-type', 'text/csv; charset=utf-8')
    .header('content-disposition', `attachment; filename="${r.filename}"`)
    .header('cache-control', 'no-store')
    .send(r.csv);

// Rutas de solo lectura que también aceptan llaves de API con permiso read (Ed25519 o token de lectura)
export const ACCOUNT_KEY_ROUTES = [
  'GET /v1/portal/balances', 'GET /v1/portal/activity',
  'GET /v1/portal/accounts/:asset/entries', 'GET /v1/portal/accounts/:asset/entries.csv',
  'GET /v1/portal/statements/:period', 'GET /v1/portal/deposit-addresses',
  'GET /v1/portal/deposits', 'GET /v1/portal/notices', 'GET /v1/portal/assets',
];

export async function portalAccountRoutes(app: FastifyInstance) {
  app.get('/balances', async (req) => A.balances(clientOf(req)));
  // Multi-red: activos habilitados para el cliente (los administra 856) y redes encendidas
  app.get('/assets', async (req) => myAssets(clientOf(req)));

  app.get('/activity', async (req) => {
    const q = parse(z.object({ limit: z.coerce.number().int().min(1).max(50).default(10) }), req.query);
    return A.activity(clientOf(req), q.limit);
  });

  app.get<{ Params: { asset: string } }>('/accounts/:asset/entries', async (req) => {
    const q = parse(Range.extend({ limit: z.coerce.number().int().min(1).max(200).default(50), cursor }), req.query);
    return A.accountEntries(clientOf(req), { asset: parse(assetId, req.params.asset), ...q });
  });
  app.get<{ Params: { asset: string } }>('/accounts/:asset/entries.csv', async (req, reply) => {
    const q = parse(Range, req.query);
    return sendCsv(reply, await A.accountEntriesCsv(clientOf(req), { asset: parse(assetId, req.params.asset), ...q }));
  });

  // /statements/2026-10?asset=X (JSON) y /statements/2026-10.csv?asset=X
  app.get<{ Params: { period: string } }>('/statements/:period', async (req, reply) => {
    const { asset } = parse(z.object({ asset: assetId }), req.query);
    const m = /^(\d{4}-\d{2})(\.csv)?$/.exec(req.params.period);
    if (!m) throw new HttpError(400, 'Periodo inválido (AAAA-MM o AAAA-MM.csv)', 'validation_error');
    if (m[2]) return sendCsv(reply, await A.statementCsv(clientOf(req), m[1], asset));
    return A.statement(clientOf(req), m[1], asset);
  });

  app.get('/deposit-addresses', async (req) => A.listDepositAddresses(clientOf(req)));
  app.post('/deposit-addresses', async (req, reply) => {
    const p = req.portal!;
    if (p.kind !== 'client_user') throw new HttpError(403, 'Requiere sesión de usuario del portal', 'session_required');
    if (!roleAtLeast(p.user.role, 'operator')) throw new HttpError(403, 'Requiere rol operator', 'forbidden');
    const b = parse(z.object({ network: z.string().min(3).max(40).optional() }), req.body ?? {});
    return reply.code(201).send(await A.createDepositAddress(p.clientId, b.network));
  });

  app.get('/deposits', async (req) => {
    const q = parse(z.object({
      status: z.enum(['pending', 'held', 'credited', 'orphaned']).optional(),
      limit: z.coerce.number().int().min(1).max(200).default(50), cursor,
    }), req.query);
    return A.listDeposits(clientOf(req), q);
  });

  app.get('/notices', async (req) => {
    const p = req.portal!;
    return A.notices(p.clientId, p.kind === 'client_user' ? p.user : undefined, p.kind !== 'assist');
  });
}
