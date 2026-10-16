// Portal de clientes — fase F1: recibir euros (SEPA → EURe). Se registra dentro de portalRoutes (hereda autenticación,
// anti-CSRF, gate de 2FA y bitácora). Todo filtrado por el cliente de la sesión o de la llave: lo de otro cliente → 404.
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { HttpError } from '../idempotency.js';
import * as F from '../fiat/service.js';

const parse = <S extends z.ZodTypeAny>(s: S, v: unknown): z.infer<S> => {
  const r = s.safeParse(v);
  if (!r.success) throw new HttpError(400, r.error.issues.map((i) => `${i.path.join('.') || 'cuerpo'}: ${i.message}`).join('; '), 'validation_error');
  return r.data;
};
const uuid = z.string().uuid();
const page = { limit: z.coerce.number().int().min(1).max(200).default(50), cursor: z.string().max(300).optional() };

// Llaves: lectura con permiso read; crear o cancelar avisos con permiso trade (solo Ed25519)
export const FIAT_KEY_READ = [
  'GET /v1/portal/fiat/instructions', 'GET /v1/portal/fiat/payment-intents', 'GET /v1/portal/fiat/payment-intents/:id', 'GET /v1/portal/fiat/deposits',
];
export const FIAT_KEY_WRITE = ['POST /v1/portal/fiat/payment-intents', 'POST /v1/portal/fiat/payment-intents/:id/cancel'];

export async function portalFiatRoutes(app: FastifyInstance) {
  app.get('/fiat/instructions', async (req) => F.instructions(req.portal!.clientId));

  app.post('/fiat/payment-intents', async (req, reply) => {
    const b = parse(z.object({
      amount: z.string().regex(/^\d{1,15}(\.\d{1,2})?$/, 'euros con hasta 2 decimales, sin separador de miles (p. ej. "1250.50")'),
      expected_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'fecha AAAA-MM-DD').optional(),
      note: z.string().trim().max(300).optional(),
    }), req.body);
    const sig = req.headers['x-856-signature'];
    return reply.code(201).send(await F.createIntent(req.portal!, b, { ip: req.ip, signature: typeof sig === 'string' ? sig : undefined }));
  });
  app.get('/fiat/payment-intents', async (req) => F.listIntents(req.portal!.clientId, parse(z.object({
    status: z.enum(['open', 'matched', 'expired', 'cancelled']).optional(), ...page,
  }), req.query)));
  app.get<{ Params: { id: string } }>('/fiat/payment-intents/:id', async (req) => F.getIntent(req.portal!.clientId, parse(uuid, req.params.id)));
  app.post<{ Params: { id: string } }>('/fiat/payment-intents/:id/cancel', async (req) => F.cancelIntent(req.portal!, parse(uuid, req.params.id)));

  app.get('/fiat/deposits', async (req) => F.listDepositsPortal(req.portal!.clientId, parse(z.object(page), req.query)));
}
