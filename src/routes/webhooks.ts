import type { FastifyInstance } from 'fastify';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { config } from '../config.js';
import { detectDeposits } from '../ledger/transfers.js';

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

    const evt = req.body as { id?: string; type?: string; event?: { activity?: { hash?: string }[] } };
    req.log.info({ id: evt.id, type: evt.type }, 'Evento Alchemy recibido');
    // Address Activity: cada hash se analiza contra las wallets de depósito (idempotente por tx+log)
    const hashes = [...new Set((evt.event?.activity ?? []).map((a) => a.hash).filter((h): h is string => !!h))];
    let detected = 0;
    for (const h of hashes) {
      try { detected += (await detectDeposits(h, 'webhook')).deposits.length; }
      catch (e) { req.log.warn({ tx: h, err: (e as Error).message }, 'hash del webhook no procesado'); }
    }
    return { ok: true, hashes: hashes.length, deposits: detected };
  });
}
