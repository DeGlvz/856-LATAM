// Fase F1 — consola: entrada de fiat (tesorería única). Se registra dentro de /v1 (sesión de operador o API_KEYS).
// Alta, liberar y rechazar: solo sesión de un tesorero y con código 2FA (una API_KEY global nunca libera fondos).
// Los avisos de pago los origina solo el cliente: desde aquí → 403 origin_not_client.
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { stepUp } from '../auth/operator-admin.js';
import { isProduction } from '../config.js';
import { HttpError } from '../idempotency.js';
import * as F from '../fiat/service.js';

const parse = <S extends z.ZodTypeAny>(s: S, v: unknown): z.infer<S> => {
  const r = s.safeParse(v);
  if (!r.success) throw new HttpError(400, r.error.issues.map((i) => `${i.path.join('.') || 'cuerpo'}: ${i.message}`).join('; '), 'validation_error');
  return r.data;
};
const uuid = z.string().uuid();
const code6 = z.string().regex(/^\d{6}$/, 'código de 6 dígitos');
const reason = z.string().trim().min(5, 'Indique el motivo (mín. 5 caracteres)').max(500);
const eur = z.string().regex(/^\d{1,15}(\.\d{1,2})?$/, 'euros con hasta 2 decimales');

/** Tesorero con sesión de consola y código 2FA vigente (el rol lo valida el hook de /v1). */
async function treasurer2fa(req: FastifyRequest, code: string | undefined) {
  const p = req.principal;
  if (p?.kind !== 'operator') throw new HttpError(403, 'Requiere sesión de un tesorero en la consola (con 2FA)', 'session_required');
  if (p.operator.role !== 'tesorero') throw new HttpError(403, 'Requiere rol tesorero', 'forbidden');
  await stepUp(p.operator, code ?? '');
  return p.operator.email;
}
function requireTreasurerSession(req: FastifyRequest) {
  const p = req.principal;
  if (p?.kind !== 'operator') throw new HttpError(403, 'Requiere sesión de tesorero', 'session_required');
  if (p.operator.role !== 'tesorero') throw new HttpError(403, 'Requiere rol tesorero', 'forbidden');
}
const noSimulationInProduction = () => {
  if (isProduction) throw new HttpError(403, 'La simulación de depósitos no existe en production', 'simulation_disabled');
};

export async function fiatConsoleRoutes(app: FastifyInstance) {
  app.get('/console/fiat/status', async () => F.status());

  app.post('/console/fiat/setup', async (req) => {
    const b = parse(z.object({ code: code6.optional() }), req.body ?? {});
    const by = await treasurer2fa(req, b.code);
    return F.setup(by, req.log);
  });

  app.get('/console/fiat/accounts', async (req) => {
    requireTreasurerSession(req);
    return { accounts: await F.listAccountsConsole() };
  });

  app.post<{ Params: { clientId: string } }>('/console/fiat/clients/:clientId/accounts/activate', async (req, reply) => {
    const clientId = parse(uuid, req.params.clientId);
    const b = parse(z.object({ provider: z.enum(['monerium', 'mock', 'transak', 'circle']), code: code6.optional() }), req.body ?? {});
    const by = await treasurer2fa(req, b.code);
    await F.assertRecentTemplateSimulation(clientId);
    return reply.code(201).send(await F.activateClientAccount(clientId, b.provider, by, req.log));
  });

  app.post<{ Params: { id: string } }>('/console/fiat/accounts/:id/close', async (req) => {
    const b = parse(z.object({ code: code6.optional(), reason }), req.body ?? {});
    const by = await treasurer2fa(req, b.code);
    return F.closeClientAccount(parse(uuid, req.params.id), by, b.reason);
  });

  // Sondeo inmediato (normalmente lo hace el worker cada FIAT_POLL_INTERVAL_MS)
  app.post('/console/fiat/poll', async (req) => F.fiatTick(req.log, true));

  app.get('/console/fiat/deposits', async (req) => F.listDepositsConsole(parse(z.object({
    status: z.enum(['received', 'minted', 'reconciled', 'released', 'review', 'rejected']).optional(), client_id: uuid.optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50), cursor: z.string().max(300).optional(),
  }), req.query)));

  app.post<{ Params: { id: string } }>('/console/fiat/deposits/:id/release', async (req) => {
    const b = parse(z.object({ code: code6.optional(), client_id: uuid.optional(), reason: reason.optional() }), req.body ?? {});
    const by = await treasurer2fa(req, b.code);
    return F.release(parse(uuid, req.params.id), by, { client_id: b.client_id, reason: b.reason });
  });

  app.post<{ Params: { id: string } }>('/console/fiat/deposits/:id/reject', async (req) => {
    const b = parse(z.object({ code: code6.optional(), reason }), req.body ?? {});
    const by = await treasurer2fa(req, b.code);
    return F.reject(parse(uuid, req.params.id), by, b.reason);
  });

  // El aviso de pago lo crea solo el cliente (portal o su llave): la consola y las API_KEYS globales no lo originan
  app.post('/console/fiat/payment-intents', async () => {
    throw new HttpError(403, 'Solo el cliente crea avisos de pago (portal o su llave de API); la consola solo concilia y libera', 'origin_not_client');
  });

  // ── Sandbox: simulación con el proveedor simulado (nunca en production) ──
  app.post('/console/fiat/simulate', async (req, reply) => {
    noSimulationInProduction();
    const b = parse(z.object({
      amount: eur, memo: z.string().max(140).optional(), payer_name: z.string().max(140).optional(),
      payer_iban: z.string().max(40).optional(), tx_hash: z.string().regex(/^0x[0-9a-fA-F]{64}$/).optional(),
      state: z.enum(['pending', 'processed', 'rejected']).optional(), client_id: uuid.optional(),
    }), req.body);
    return reply.code(201).send(await F.simulateOrder(b));
  });
  app.post<{ Params: { orderId: string } }>('/console/fiat/simulate/:orderId/process', async (req) => {
    noSimulationInProduction();
    const b = parse(z.object({ tx_hash: z.string().regex(/^0x[0-9a-fA-F]{64}$/), client_id: uuid.optional() }), req.body);
    return F.simulateProcess(parse(z.string().min(3).max(80), req.params.orderId), b.tx_hash, b.client_id);
  });
}
