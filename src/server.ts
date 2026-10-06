import Fastify from 'fastify';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import { config } from './config.js';
import { client } from './chain.js';
import { chainRoutes } from './routes/chain.js';
import { webhookRoutes } from './routes/webhooks.js';

const app = Fastify({ logger: true, trustProxy: true });

// Conserva el cuerpo crudo para verificar firmas HMAC
app.addContentTypeParser('application/json', { parseAs: 'string' }, (req, body, done) => {
  (req as unknown as { rawBody: string }).rawBody = body as string;
  try { done(null, body ? JSON.parse(body as string) : {}); } catch (e) { done(e as Error, undefined); }
});

await app.register(helmet);
await app.register(rateLimit, { max: config.RATE_LIMIT_PER_MIN, timeWindow: '1 minute' });

app.get('/health', async () => {
  const [chainId, block] = await Promise.all([client.getChainId(), client.getBlockNumber()]);
  return { status: 'ok', network: config.ALCHEMY_NETWORK, chainId, block: block.toString() };
});

// /v1 protegido con API key (excepto webhooks, que validan firma)
await app.register(async (v1) => {
  v1.addHook('onRequest', async (req, reply) => {
    if (req.url.startsWith('/v1/webhooks/')) return;
    const k = req.headers['x-api-key'];
    if (typeof k !== 'string' || !config.API_KEYS.has(k)) return reply.code(401).send({ error: 'No autorizado' });
  });
  await v1.register(chainRoutes);
  await v1.register(webhookRoutes);
}, { prefix: '/v1' });

app.setErrorHandler((e, req, reply) => {
  const err = e as { statusCode?: number; message: string };
  req.log.error(e);
  reply.code(err.statusCode ?? 502).send({ error: err.statusCode ? err.message : 'Error upstream RPC' });
});

for (const s of ['SIGINT', 'SIGTERM'] as const) process.on(s, () => app.close().then(() => process.exit(0)));

await app.listen({ port: config.PORT, host: config.HOST });
