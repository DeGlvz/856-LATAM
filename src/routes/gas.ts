// Registro de gas en el libro (consola). Registrar: solo sesión de tesorero con código 2FA; consultar: cualquier rol.
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { stepUp } from '../auth/operator-admin.js';
import { HttpError } from '../idempotency.js';
import * as G from '../ledger/gas-funding.js';

const parse = <S extends z.ZodTypeAny>(s: S, v: unknown): z.infer<S> => {
  const r = s.safeParse(v);
  if (!r.success) throw new HttpError(400, r.error.issues.map((i) => `${i.path.join('.') || 'cuerpo'}: ${i.message}`).join('; '), 'validation_error');
  return r.data;
};

export async function gasRoutes(app: FastifyInstance) {
  app.get('/gas-fundings', async (req) => {
    const q = parse(z.object({ network: z.string().min(3).max(40).optional(), limit: z.coerce.number().int().min(1).max(500).default(100) }), req.query);
    return G.listGasFundings(q.network, q.limit);
  });
  app.post('/gas-fundings', async (req, reply) => {
    const b = parse(z.object({
      network: z.string().min(3).max(40), tx_hash: z.string().regex(/^0x[0-9a-fA-F]{64}$/, 'hash de 32 bytes con 0x'),
      code: z.string().regex(/^\d{6}$/, 'código de 6 dígitos').optional(),
    }), req.body);
    const p = req.principal;
    if (p?.kind !== 'operator') throw new HttpError(403, 'Requiere sesión de un tesorero en la consola (con 2FA)', 'session_required');
    await stepUp(p.operator, b.code ?? '');
    return reply.code(201).send(await G.registerGasFunding(b.network, b.tx_hash, p.operator.email));
  });
}
