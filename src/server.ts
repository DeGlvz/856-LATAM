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
import { portalRoutes } from './routes/portal.js';
import { transferRoutes } from './routes/transfers.js';
import { authRoutes } from './routes/auth.js';
import { consoleRoutes } from './routes/console.js';
import { configDraftRoutes } from './routes/config-drafts.js';
import { branchCaseRoutes } from './routes/branch-cases.js';
import { usageRoutes } from './routes/usage.js';
import { startUsageFlush } from './usage.js';
import { operatorRoutes } from './routes/operators.js';
import { audit, bootstrapOperator, hasRole, requiredRole, sessionFromRequest } from './auth/operators.js';
import { ensureHotWalletRegistered, startWorker } from './ledger/transfers.js';
import { getSigner, initSigner } from './chain/signer.js';
import { pool } from './db.js';
import { migrate } from './migrations/index.js';
import { ensureAllSystemAccounts } from './ledger/service.js';
import { clientAssetRoutes } from './routes/client-assets.js';
import { fiatConsoleRoutes } from './routes/fiat.js';
import { fiatRailsConsoleRoutes } from './routes/fiat-rails.js';
import { gasRoutes } from './routes/gas.js';
import { accessRequestRoutes, PUBLIC_ACCESS_REQUEST_PATH } from './routes/access-requests.js';
import { verifyNetworks } from './chain/networks.js';
import { ensureCatalog } from './chain/catalog.js';
import { assertTreasuryAtBoot, configErrors, foreignNetworks, SETUP_ALLOWED, setupRequired } from './environment.js';

const app = Fastify({ logger: true, trustProxy: true });

// Fase M1: el ambiente (production/sandbox) se valida antes de tocar la base o la cadena
const envErrors = configErrors();
if (envErrors.length) {
  for (const e of envErrors) app.log.fatal({ environment: config.ENVIRONMENT }, e);
  await pool.end().catch(() => undefined);
  process.exit(1);
}
app.log.info({ environment: config.ENVIRONMENT }, 'ambiente');
// Firmante asíncrono (KMS): antes de migrar, registrar la hot wallet o arrancar el worker
await initSigner();

if (config.MIGRATE_ON_START) await migrate(pool, (m) => app.log.info(m));
// Activos de redes del otro ambiente: inactivos (no aparecen ni operan aquí). Activos main: alta idempotente.
await pool.query('UPDATE assets SET active = false WHERE active AND network = ANY($1)', [foreignNetworks()]);
await ensureCatalog(app.log);
await ensureAllSystemAccounts();
await verifyNetworks(app.log);
await ensureHotWalletRegistered();
await bootstrapOperator(app.log);
try { await assertTreasuryAtBoot(app.log); } catch (e) {
  app.log.fatal((e as Error).message);
  await pool.end().catch(() => undefined);
  process.exit(1);
}

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

// CORS solo para el formulario público de la landing (otros orígenes); el resto del API sigue siendo de mismo origen
app.addHook('onRequest', async (req, reply) => {
  if (req.url.split('?')[0] !== PUBLIC_ACCESS_REQUEST_PATH) return;
  const origin = req.headers.origin;
  if (!origin || !config.LANDING_ORIGINS.has(origin)) return;
  reply.header('access-control-allow-origin', origin).header('vary', 'Origin').header('cross-origin-resource-policy', 'cross-origin');
  if (req.method === 'OPTIONS') {
    return reply.header('access-control-allow-methods', 'POST, OPTIONS').header('access-control-allow-headers', 'content-type, accept')
      .header('access-control-max-age', '600').code(204).send();
  }
});

// Modo de alta (production sin tesorero con 2FA): solo login y 2FA de la consola
app.addHook('onRequest', async (req, reply) => {
  const path = req.url.split('?')[0];
  if (!path.startsWith('/v1/') || SETUP_ALLOWED.some((r) => r.test(path))) return;
  if (await setupRequired()) {
    return reply.code(503).send({ error: 'Servicio en modo de alta: un tesorero debe activar su 2FA en la consola (Seguridad) antes de operar', code: 'setup_required' });
  }
});

app.get('/health', async () => {
  const [chainId, block, db] = await Promise.all([
    client.getChainId(), client.getBlockNumber(),
    pool.query('SELECT 1').then(() => 'ok', () => 'down'),
  ]);
  return { status: db === 'ok' ? 'ok' : 'degraded', environment: config.ENVIRONMENT, network: config.ALCHEMY_NETWORK, chainId, block: block.toString(), db };
});

// /v1: API key (integraciones) o sesión de operador (consola). Webhooks validan firma; login es público.
const PUBLIC = new Set(['/v1/meta', '/v1/auth/login', '/v1/auth/login/totp', '/v1/auth/invites/lookup', '/v1/auth/invites/accept', PUBLIC_ACCESS_REQUEST_PATH]);
await app.register(async (v1) => {
  v1.addHook('onRequest', async (req, reply) => {
    const path = req.url.split('?')[0];
    if (path.startsWith('/v1/webhooks/') || path.startsWith('/v1/fiat/webhooks/') || PUBLIC.has(path)) return;
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
    const assistMatch = /^\/v1\/console\/clients\/([^/]+)\/assist-token$/.exec(req.url.split('?')[0]);
    if (assistMatch) {
      if (reply.statusCode >= 400) {
        const body = (req.body ?? {}) as { origin?: unknown };
        const trigger = body.origin === 'client_list' || body.origin === 'client_detail' ? body.origin : 'unknown';
        await audit({
          operator_id: p?.kind === 'operator' ? p.operator.id : null,
          actor: p?.kind === 'operator' ? `console:${p.operator.email}` : 'anonimo',
          action: 'client_impersonation_initiated',
          target: assistMatch[1], status: reply.statusCode, ip: req.ip,
          metadata: { result: 'denied', trigger },
        }).catch((e) => req.log.error(e, 'audit_log'));
      }
      return;
    }
    if (p?.kind !== 'operator' || req.method === 'GET' || req.method === 'HEAD') return;
    const route = req.routeOptions.url ?? req.url.split('?')[0];
    if (route.startsWith('/v1/auth/')) return; // login/logout ya se registran con más detalle
    // Motivo (cancelaciones, rechazos) a la bitácora; nunca códigos, contraseñas ni el resto del cuerpo
    const reason = (req.body as { reason?: unknown } | undefined)?.reason;
    const params = (req.params ?? {}) as Record<string, string>;
    let clientId = params.clientId ?? null;
    if (!clientId && route === '/v1/console/fiat/accounts/:id/close' && params.id) {
      try {
        const { rows: [account] } = await pool.query('SELECT client_id FROM fiat_accounts WHERE id = $1', [params.id]);
        clientId = account?.client_id ?? null;
      } catch (e) { req.log.error(e, 'audit_fiat_account_scope'); }
    }
    const body = (req.body ?? {}) as { provider?: unknown };
    await audit({ operator_id: p.operator.id, actor: p.operator.email, action: `${req.method} ${route}`,
      target: Object.values(params).join(',') || null, status: reply.statusCode, ip: req.ip, client_id: clientId,
      metadata: { ...(typeof reason === 'string' ? { reason: reason.slice(0, 300) } : {}),
        ...(typeof body.provider === 'string' ? { provider: body.provider } : {}) } })
      .catch((e) => req.log.error(e, 'audit_log'));
  });
  // Público: ambiente del despliegue (distintivo «PRUEBAS» en consola y portal, también antes del login)
  v1.get('/meta', async () => ({ environment: config.ENVIRONMENT, setup_required: await setupRequired() }));
  await v1.register(authRoutes);
  await v1.register(consoleRoutes);
  await v1.register(operatorRoutes);
  await v1.register(chainRoutes);
  await v1.register(webhookRoutes);
  await v1.register(ledgerRoutes);
  await v1.register(nettingRoutes);
  await v1.register(transferRoutes);
  await v1.register(clientAssetRoutes);
  await v1.register(fiatConsoleRoutes);
  await v1.register(fiatRailsConsoleRoutes);
  await v1.register(configDraftRoutes);
  await v1.register(branchCaseRoutes);
  await v1.register(usageRoutes);
  await v1.register(gasRoutes);
  await v1.register(accessRequestRoutes);
}, { prefix: '/v1' });

// Portal de clientes: autenticación propia y aislada (no hereda los hooks de /v1)
await app.register(portalRoutes, { prefix: '/v1/portal' });

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
  // Portal de clientes: segunda entrada del mismo build (portal.html)
  const portal = (_: unknown, reply: import('fastify').FastifyReply) => reply.header('cache-control', 'no-cache').sendFile('portal.html');
  app.get('/portal', portal);
  app.get('/portal/*', portal);
  // Página pública de 856 (tercera entrada del build: landing.html) en la raíz del dominio
  const landing = (_: unknown, reply: import('fastify').FastifyReply) => reply.header('cache-control', 'no-cache').sendFile('landing.html');
  app.get('/', landing);
  app.get('/index.html', (_, reply) => reply.redirect('/'));
} else {
  app.log.warn('web/dist no existe: la consola no se sirve (compilar con npm run build:web)');
}

for (const s of ['SIGINT', 'SIGTERM'] as const) process.on(s, () => app.close().then(() => pool.end()).then(() => process.exit(0)));

await app.listen({ port: config.PORT, host: config.HOST });
startUsageFlush(app.log);

if (config.WORKER_ENABLED) {
  const signer = getSigner();
  app.log.info({ signer: signer?.kind ?? 'ninguno', address: signer?.address() }, 'worker de transferencias activo');
  startWorker(app.log);
}
