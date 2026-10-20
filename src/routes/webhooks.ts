import type { FastifyInstance } from 'fastify';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { networks } from '../chain/networks.js';
import { detectDeposits } from '../ledger/transfers.js';
import * as F from '../fiat/service.js';
import * as OF from '../openfort/webhook.js';
import { config } from '../config.js';

// Receptor de Alchemy Notify (Address Activity). Multi-red: cada red tiene su webhook y su llave de firma;
// la red del evento es la de la llave que valida la firma (nunca se confía en el cuerpo para elegirla).
export async function webhookRoutes(app: FastifyInstance) {
  app.post('/webhooks/alchemy', async (req, reply) => {
    const keyed = networks.filter((n) => n.signingKey);
    if (!keyed.length) return reply.code(503).send({ error: 'Webhook no configurado' });

    const sig = req.headers['x-alchemy-signature'];
    const raw = (req as unknown as { rawBody?: string }).rawBody ?? '';
    const match = typeof sig === 'string' ? keyed.find((n) => {
      const expected = createHmac('sha256', n.signingKey!).update(raw, 'utf8').digest('hex');
      return sig.length === expected.length && timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
    }) : undefined;
    if (!match) return reply.code(401).send({ error: 'Firma inválida' });

    const evt = req.body as { id?: string; type?: string; event?: { network?: string; activity?: { hash?: string }[] } };
    req.log.info({ id: evt.id, type: evt.type, network: match.id, alchemy_network: evt.event?.network }, 'Evento Alchemy recibido');
    // Address Activity: cada hash se analiza contra las wallets de depósito de esa red (idempotente por red+tx+log)
    const hashes = [...new Set((evt.event?.activity ?? []).map((a) => a.hash).filter((h): h is string => !!h))];
    let detected = 0;
    for (const h of hashes) {
      try { detected += (await detectDeposits(h, 'webhook', match.id)).deposits.length; }
      catch (e) { req.log.warn({ tx: h, network: match.id, err: (e as Error).message }, 'hash del webhook no procesado'); }
    }
    return { ok: true, network: match.id, hashes: hashes.length, deposits: detected };
  });

  // Openfort (opcional): firma HMAC-SHA256 sobre el cuerpo crudo; solo guarda y concilia, nunca asienta en el libro.
  app.post('/webhooks/openfort', async (req, reply) => {
    if (!config.OPENFORT_ENABLED) return reply.code(404).send({ error: 'No encontrado' });
    if (!config.OPENFORT_WEBHOOK_SECRET) return reply.code(503).send({ error: 'Webhook no configurado' });
    const raw = (req as unknown as { rawBody?: string }).rawBody ?? '';
    if (!OF.verifySignature(raw, req.headers[OF.SIGNATURE_HEADER], config.OPENFORT_WEBHOOK_SECRET)) {
      return reply.code(401).send({ error: 'Firma inválida' });
    }
    const evt = OF.parseEvent(raw);
    if (!evt) return reply.code(400).send({ error: 'Evento inválido' });
    const r = await OF.ingest(raw, evt);
    req.log.info({ type: evt.type, duplicate: r.duplicate, matched: r.matched }, 'Evento Openfort recibido');
    return { ok: true, duplicate: r.duplicate, matched: !!r.matched };
  });

  // Ingress genérico: solo confirma después de verificar firma y persistir durablemente el evento.
  app.post<{ Params: { providerId: string } }>('/fiat/webhooks/:providerId', async (req) => {
    const raw = (req as unknown as { rawBody?: string }).rawBody ?? '';
    return F.acceptWebhook(req.params.providerId, req.headers as Record<string, unknown>, raw);
  });

  // Ruta legacy de Monerium conservada durante la transición.
  app.post('/webhooks/monerium', async (req, reply) => {
    const raw = (req as unknown as { rawBody?: string }).rawBody ?? '';
    const result = await F.acceptWebhook(undefined, req.headers as Record<string, unknown>, raw);
    req.log.info({ verified: result.verified, duplicate: result.duplicate }, 'Aviso fiat recibido');
    return reply.send(result);
  });
}
