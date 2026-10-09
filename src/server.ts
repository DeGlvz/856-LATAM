import Fastify from 'fastify';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import { config } from './config.js';
import { client } from './chain.js';
import { chainRoutes } from './routes/chain.js';
import { webhookRoutes } from './routes/webhooks.js';
import { ledgerRoutes } from './routes/ledger.js';
import { nettingRoutes } from './routes/netting.js';
import { pool } from './db.js';
import { migrate } from './migrations/index.js';
import { ensureAllSystemAccounts } from './ledger/service.js';

const app = Fastify({ logger: true, trustProxy: true });

if (config.MIGRATE_ON_START) await migrate(pool, (m) => app.log.info(m));
await ensureAllSystemAccounts();

// Conserva el cuerpo crudo para verificar firmas HMAC
app.addContentTypeParser('application/json', { parseAs: 'string' }, (req, body, done) => {
  (req as unknown as { rawBody: string }).rawBody = body as string;
  try { done(null, body ? JSON.parse(body as string) : {}); } catch (e) { done(e as Error, undefined); }
});

await app.register(helmet);
await app.register(rateLimit, { max: config.RATE_LIMIT_PER_MIN, timeWindow: '1 minute' });

app.get('/health', async () => {
  const [chainId, block, db] = await Promise.all([
    client.getChainId(), client.getBlockNumber(),
    pool.query('SELECT 1').then(() => 'ok', () => 'down'),
  ]);
  return { status: db === 'ok' ? 'ok' : 'degraded', network: config.ALCHEMY_NETWORK, chainId, block: block.toString(), db };
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
  await v1.register(ledgerRoutes);
  await v1.register(nettingRoutes);
}, { prefix: '/v1' });

app.setErrorHandler((e, req, reply) => {
  const err = e as { statusCode?: number; message: string; code?: string };
  // Errores de PostgreSQL traducidos a HTTP sin filtrar detalles internos
  const pg: Record<string, [number, string]> = {
    '23505': [409, 'El recurso ya existe'], '23503': [422, 'Referencia inexistente'],
    '22P02': [400, 'Formato inválido'], '23514': [422, 'Restricción de negocio violada'], P0001: [422, err.message],
  };
  const mapped = err.code ? pg[err.code] : undefined;
  if (mapped) return reply.code(mapped[0]).send({ error: mapped[1], code: err.code });
  if (err.statusCode && err.statusCode < 500) return reply.code(err.statusCode).send({ error: err.message, code: err.code });
  req.log.error(e);
  reply.code(502).send({ error: 'Error interno' });
});

for (const s of ['SIGINT', 'SIGTERM'] as const) process.on(s, () => app.close().then(() => pool.end()).then(() => process.exit(0)));

await app.listen({ port: config.PORT, host: config.HOST });
