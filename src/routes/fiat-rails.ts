// Consola: control de rieles fiat. Lectura (enmascarada) para tesorero o ejecutivo; todo cambio exige sesión de tesorero,
// header x-856-console (hook de /v1), código 2FA y motivo. Una API_KEY global nunca muta ni lee cuentas: 403 forbidden.
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Operator } from '../auth/operators.js';
import { HttpError } from '../idempotency.js';
import * as R from '../fiat/rails.js';
import { treasurer2fa } from './fiat.js';

const parse = <S extends z.ZodTypeAny>(s: S, v: unknown): z.infer<S> => {
  const r = s.safeParse(v);
  if (!r.success) throw new HttpError(400, r.error.issues.map((i) => `${i.path.join('.') || 'cuerpo'}: ${i.message}`).join('; '), 'validation_error');
  return r.data;
};
const railId = z.string().regex(/^[a-z0-9][a-z0-9_-]{1,39}$/, 'rail_id inválido');
const code6 = z.string().regex(/^\d{6}$/, 'código de 6 dígitos');
const reason = z.string().trim().min(5, 'Indique el motivo (mín. 5 caracteres)').max(500);
const money = z.string().regex(/^\d{1,15}(\.\d{1,2})?$/, 'monto con hasta 2 decimales');
const short = z.string().trim().max(300);
const currency = z.string().regex(/^[A-Z]{3}$/, 'moneda ISO de 3 letras mayúsculas');
const country = z.string().regex(/^[A-Z]{2}$/, 'país ISO de 2 letras mayúsculas');
const railType = z.enum(['wire', 'ach', 'sepa', 'spei', 'pix', 'otc', 'generic']);

const forbidden = () => new HttpError(403, 'Requiere sesión de un tesorero o ejecutivo', 'forbidden');
function viewer(req: FastifyRequest) {
  const p = req.principal;
  if (p?.kind !== 'operator' || p.operator.role === 'lectura') throw forbidden();
}
async function mutator(req: FastifyRequest, code: string | undefined): Promise<Operator> {
  if (req.principal?.kind !== 'operator') throw new HttpError(403, 'Requiere sesión de un tesorero en la consola (con 2FA)', 'forbidden');
  await treasurer2fa(req, code);
  return req.principal.operator;
}

export async function fiatRailsConsoleRoutes(app: FastifyInstance) {
  app.get('/console/fiat/rails', async (req) => {
    viewer(req);
    return R.listRails();
  });

  app.post('/console/fiat/rails', async (req, reply) => {
    const b = parse(z.object({
      code: code6.optional(), reason, rail_id: railId, label: z.string().trim().min(2).max(100), currency, country: country.nullable().optional(),
      rail_type: railType, priority: z.number().int().min(0).max(1000).optional(), fallback_of: railId.nullable().optional(),
      min_amount: money.nullable().optional(), max_amount: money.nullable().optional(), recommended_for: short.nullable().optional(),
      settlement_time: short.nullable().optional(), requires_review: z.boolean().optional(), maintenance_message: short.nullable().optional(),
      visibility: z.enum(['all', 'restricted']).optional(),
    }).strict(), req.body ?? {});
    const op = await mutator(req, b.code);
    const { code: _c, reason: why, ...input } = b;
    return reply.code(201).send(await R.createRail(op, input, why, req.ip));
  });

  app.put<{ Params: { rail_id: string } }>('/console/fiat/rails/:rail_id', async (req) => {
    const id = parse(railId, req.params.rail_id);
    const b = parse(z.object({
      code: code6.optional(), reason,
      is_enabled: z.boolean().optional(), visibility: z.enum(['all', 'restricted']).optional(), maintenance_message: short.nullable().optional(),
      min_amount: money.nullable().optional(), max_amount: money.nullable().optional(),
      recommended_for: short.nullable().optional(), settlement_time: short.nullable().optional(),
      priority: z.number().int().min(0).max(1000).optional(), fallback_of: railId.nullable().optional(),
      label: z.string().trim().min(2).max(100).optional(), currency: currency.optional(), country: country.nullable().optional(),
      rail_type: railType.optional(), requires_review: z.boolean().optional(), is_archived: z.boolean().optional(),
    }).strict(), req.body ?? {});
    const op = await mutator(req, b.code);
    const { code: _c, reason: why, ...patch } = b;
    return R.toggleRail(op, id, patch, why, req.ip);
  });

  app.post<{ Params: { rail_id: string } }>('/console/fiat/rails/:rail_id/delete', async (req) => {
    const b = parse(z.object({ code: code6.optional(), reason, confirm: railId }).strict(), req.body ?? {});
    const op = await mutator(req, b.code);
    return R.deleteRail(op, parse(railId, req.params.rail_id), b.confirm, b.reason, req.ip);
  });

  app.post<{ Params: { rail_id: string } }>('/console/fiat/rails/:rail_id/accounts', async (req, reply) => {
    const id = parse(railId, req.params.rail_id);
    const b = parse(z.object({ code: code6.optional(), reason, account: z.record(z.string(), z.unknown()), inherit: z.boolean().optional() }).strict(), req.body ?? {});
    const op = await mutator(req, b.code);
    return reply.code(201).send(await R.proposeAccount(op, id, b.account, b.reason, req.ip, b.inherit));
  });

  app.post<{ Params: { rail_id: string } }>('/console/fiat/rails/:rail_id/account/reveal', async (req) => {
    const b = parse(z.object({ code: code6.optional(), reason }).strict(), req.body ?? {});
    const op = await mutator(req, b.code);
    return R.revealAccount(op, parse(railId, req.params.rail_id), b.reason, req.ip);
  });

  const decision = z.object({ code: code6.optional(), reason }).strict();
  const uuid = z.string().uuid();
  app.get<{ Params: { rail_id: string } }>('/console/fiat/rails/:rail_id/clients', async (req) => {
    viewer(req);
    return R.listRailClients(parse(railId, req.params.rail_id));
  });
  app.get<{ Params: { client_id: string } }>('/console/fiat/clients/:client_id/rails', async (req) => {
    viewer(req);
    return R.listClientRails(parse(uuid, req.params.client_id));
  });
  app.post<{ Params: { rail_id: string } }>('/console/fiat/rails/:rail_id/clients', async (req, reply) => {
    const b = parse(z.object({ code: code6.optional(), reason, client_id: uuid }).strict(), req.body ?? {});
    const op = await mutator(req, b.code);
    return reply.code(201).send(await R.assignRailClient(op, parse(railId, req.params.rail_id), b.client_id, true, b.reason, req.ip));
  });
  app.post<{ Params: { rail_id: string; client_id: string } }>('/console/fiat/rails/:rail_id/clients/:client_id/unassign', async (req) => {
    const b = parse(decision, req.body ?? {});
    const op = await mutator(req, b.code);
    return R.assignRailClient(op, parse(railId, req.params.rail_id), parse(uuid, req.params.client_id), false, b.reason, req.ip);
  });
  app.post<{ Params: { rail_id: string; version: string } }>('/console/fiat/rails/:rail_id/accounts/:version/approve', async (req) => {
    const b = parse(decision, req.body ?? {});
    const op = await mutator(req, b.code);
    return R.approveAccount(op, parse(railId, req.params.rail_id), parse(z.coerce.number().int().min(1), req.params.version), b.reason, req.ip);
  });
  app.post<{ Params: { rail_id: string; version: string } }>('/console/fiat/rails/:rail_id/accounts/:version/reject', async (req) => {
    const b = parse(decision, req.body ?? {});
    const op = await mutator(req, b.code);
    return R.rejectAccount(op, parse(railId, req.params.rail_id), parse(z.coerce.number().int().min(1), req.params.version), b.reason, req.ip);
  });
}
