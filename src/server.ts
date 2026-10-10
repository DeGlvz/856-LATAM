import Fastify from 'fastify';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import cookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';
import { client } from './chain.js';
import { chainRoutes } from './routes/chain.js';
import { webhookRoutes } from './routes/webhooks.js';
import { ledgerRoutes } from './routes/ledger.js';
import { nettingRoutes } from './routes/netting.js';
import { transferRoutes } from './routes/transfers.js';
import { authRoutes } from './routes/auth.js';
import { consoleRoutes } from './routes/console.js';
import { audit, bootstrapOperator, hasRole, requiredRole, sessionFromRequest } from './auth/operators.js';
import { ensureHotWalletRegistered, startWorker } from './ledger/transfers.js';
import { getSigner } from './chain/signer.js';
import { pool } from './db.js';
import { migrate } from './migrations/index.js';
import { ensureAllSystemAccounts } from './ledger/service.js';

const app = Fastify({ logger: true, trustProxy: true });

if (config.MIGRATE_ON_START) await migrate(pool, (m) => app.log.info(m));
await ensureAllSystemAccounts();
await ensureHotWalletRegistered();
await bootstrapOperator(app.log);

// Conserva el cuerpo crudo para verificar firmas HMAC
app.addContentTypeParser('application/json', { parseAs: 'string' }, (req, body, done) => {
  (req as unknown as { rawBody: string }).rawBody = body as string;
  try { done(null, body ? JSON.parse(body as string) : {}); } catch (e) { done(e as Error, undefined); }
});

// Debe registrarse ANTES de las rutas para que los plugins encapsulados (/v1) lo hereden
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

await app.register(helmet);
await app.register(rateLimit, { max: config.RATE_LIMIT_PER_MIN, timeWindow: '1 minute' });
await app.register(cookie);

app.get('/health', async () => {
  const [chainId, block, db] = await Promise.all([
    client.getChainId(), client.getBlockNumber(),
    pool.query('SELECT 1').then(() => 'ok', () => 'down'),
  ]);
  return { status: db === 'ok' ? 'ok' : 'degraded', network: config.ALCHEMY_NETWORK, chainId, block: block.toString(), db };
});

// /v1: API key (integraciones) o sesión de operador (consola). Webhooks validan firma; login es público.
const PUBLIC = new Set(['/v1/auth/login']);
await app.register(async (v1) => {
  v1.addHook('onRequest', async (req, reply) => {
    const path = req.url.split('?')[0];
    if (path.startsWith('/v1/webhooks/') || PUBLIC.has(path)) return;
    const k = req.headers['x-api-key'];
    if (k !== undefined) {
      if (typeof k !== 'string' || !config.API_KEYS.has(k)) return reply.code(401).send({ error: 'No autorizado' });
      req.principal = { kind: 'api', keyId: k.slice(0, 4) };
      return;
    }
    const s = await sessionFromRequest(req);
    if (!s) return reply.code(401).send({ error: 'No autorizado', code: 'session_required' });
    req.principal = { kind: 'operator', ...s };
    const mutating = req.method !== 'GET' && req.method !== 'HEAD';
    // Defensa CSRF adicional a SameSite=Strict: un formulario de otro sitio no puede enviar este header
    if (mutating && req.headers['x-856-console'] !== '1') return reply.code(403).send({ error: 'Falta el header de consola', code: 'csrf' });
    const need = requiredRole(req.method, req.routeOptions.url ?? path);
    if (!hasRole(s.operator.role, need)) {
      await audit({ operator_id: s.operator.id, actor: s.operator.email, action: `${req.method} ${req.routeOptions.url ?? path}`, status: 403, ip: req.ip, metadata: { denied: true, need } });
      return reply.code(403).send({ error: `Requiere rol ${need}`, code: 'forbidden' });
    }
  });
  // Bitácora: toda acción de escritura hecha desde la consola
  v1.addHook('onResponse', async (req, reply) => {
    const p = req.principal;
    if (p?.kind !== 'operator' || req.method === 'GET' || req.method === 'HEAD') return;
    const route = req.routeOptions.url ?? req.url.split('?')[0];
    if (route.startsWith('/v1/auth/')) return; // login/logout ya se registran con más detalle
    await audit({ operator_id: p.operator.id, actor: p.operator.email, action: `${req.method} ${route}`,
      target: Object.values((req.params ?? {}) as Record<string, string>).join(',') || null, status: reply.statusCode, ip: req.ip })
      .catch((e) => req.log.error(e, 'audit_log'));
  });
  await v1.register(authRoutes);
  await v1.register(consoleRoutes);
  await v1.register(chainRoutes);
  await v1.register(webhookRoutes);
  await v1.register(ledgerRoutes);
  await v1.register(nettingRoutes);
  await v1.register(transferRoutes);
}, { prefix: '/v1' });

// Consola de operación (SPA compilada en web/dist) servida en /console
const webDist = fileURLToPath(new URL('../web/dist/', import.meta.url));
if (existsSync(webDist)) {
  await app.register(fastifyStatic, {
    root: webDist, prefix: '/console/', wildcard: false, index: false, cacheControl: false,
    setHeaders: (res, file) => res.setHeader('cache-control', file.includes('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache'),
  });
  const spa = (_: unknown, reply: import('fastify').FastifyReply) => reply.header('cache-control', 'no-cache').sendFile('index.html');
  app.get('/console', (_, reply) => reply.redirect('/console/'));
  app.get('/console/', spa);
  app.get('/console/*', spa);
} else {
  app.log.warn('web/dist no existe: la consola no se sirve (compilar con npm run build:web)');
}

for (const s of ['SIGINT', 'SIGTERM'] as const) process.on(s, () => app.close().then(() => pool.end()).then(() => process.exit(0)));

await app.listen({ port: config.PORT, host: config.HOST });

if (config.WORKER_ENABLED) {
  const signer = getSigner();
  app.log.info({ signer: signer?.kind ?? 'ninguno', address: signer?.address() }, 'worker de transferencias activo');
  startWorker(app.log);
}
