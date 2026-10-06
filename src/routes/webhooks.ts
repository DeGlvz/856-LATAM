import type { FastifyInstance } from 'fastify';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { config } from '../config.js';

// Receptor de Alchemy Notify (Address Activity, Mined Tx, etc.)
export async function webhookRoutes(app: FastifyInstance) {
  app.post('/webhooks/alchemy', async (req, reply) => {
    const key = config.ALCHEMY_WEBHOOK_SIGNING_KEY;
    if (!key) return reply.code(503).send({ error: 'Webhook no configurado' });

    const sig = req.headers['x-alchemy-signature'];
    const raw = (req as unknown as { rawBody?: string }).rawBody ?? '';
    const expected = createHmac('sha256', key).update(raw, 'utf8').digest('hex');
    if (typeof sig !== 'string' || sig.length !== expected.length ||
        !timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) {
      return reply.code(401).send({ error: 'Firma inválida' });
    }

    const evt = req.body as { id?: string; type?: string; event?: unknown };
    req.log.info({ id: evt.id, type: evt.type }, 'Evento Alchemy recibido');
    // TODO: encolar / persistir evt.event (idempotencia por evt.id)
    return { ok: true };
  });
}
