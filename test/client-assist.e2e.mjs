// Asistencia de solo lectura: BASE KEY DATABASE_URL node test/client-assist.e2e.mjs
// Requiere la API compilada, ORIGIN_RULE=enforce y un API key de pruebas.
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const { BASE = 'http://localhost:8080', KEY, DATABASE_URL } = process.env;
if (!KEY || !DATABASE_URL) throw new Error('Defina KEY y DATABASE_URL para esta prueba E2E');

const root = fileURLToPath(new URL('../', import.meta.url));
const suffix = Math.random().toString(36).slice(2, 9);
const email = `assist-${suffix}@example.test`;
const password = 'assist-test-password-123';
const asset = 'USDC-ETH-SEPOLIA';
const db = new pg.Pool({ connectionString: DATABASE_URL });
const check = (name, condition) => {
  if (!condition) throw new Error(`Falló: ${name}`);
  console.log(`✔ ${name}`);
};
const apiKeyCall = async (method, path, body) => fetch(`${BASE}${path}`, {
  method,
  headers: {
    'x-api-key': KEY,
    ...(method === 'POST' ? { 'idempotency-key': `assist-${suffix}-${Math.random().toString(36).slice(2, 8)}` } : {}),
    ...(body ? { 'content-type': 'application/json' } : {}),
  },
  body: body ? JSON.stringify(body) : undefined,
});
function consoleSession() {
  let cookie = '';
  return async (method, path, body) => {
    const response = await fetch(`${BASE}/v1${path}`, {
      method,
      headers: {
        ...(cookie ? { cookie } : {}),
        ...(method !== 'GET' ? { 'x-856-console': '1' } : {}),
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const setCookie = response.headers.get('set-cookie');
    if (setCookie) cookie = setCookie.split(';')[0];
    return { status: response.status, body: await response.json().catch(() => null) };
  };
}

let assistSessionToken;
try {
  const clientResponse = await apiKeyCall('POST', '/v1/clients', {
    name: `Assist ${suffix}`, assets: [asset],
  });
  const client = await clientResponse.json();
  check('crea el cliente de prueba', clientResponse.status === 201 && !!client.id);

  await apiKeyCall('PATCH', `/v1/clients/${client.id}`, { status: 'active' });
  execFileSync('node', ['dist/scripts/create-operator.js', email, 'ejecutivo'], {
    cwd: root, input: `${password}\n`, env: process.env, stdio: ['pipe', 'pipe', 'ignore'],
  });
  const consoleCall = consoleSession();
  const login = await consoleCall('POST', '/auth/login', { email, password });
  check('inicia sesión de consola', login.status === 200);

  const readerEmail = `assist-reader-${suffix}@example.test`;
  execFileSync('node', ['dist/scripts/create-operator.js', readerEmail, 'lectura'], {
    cwd: root, input: `${password}\n`, env: process.env, stdio: ['pipe', 'pipe', 'ignore'],
  });
  const readerCall = consoleSession();
  await readerCall('POST', '/auth/login', { email: readerEmail, password });
  const deniedIssue = await readerCall('POST', `/console/clients/${client.id}/assist-token`, { origin: 'client_detail' });
  check('niega la emisión a operadores de solo lectura', deniedIssue.status === 403);
  const deniedIssuanceAudit = await db.query(
    `SELECT actor, action, target, metadata->>'result' AS result
       FROM audit_log WHERE action = 'client_impersonation_initiated' AND target = $1
       ORDER BY id DESC LIMIT 1`,
    [client.id],
  );
  check('audita la denegación de emisión por rol',
    deniedIssuanceAudit.rows[0]?.actor === `console:${readerEmail}` && deniedIssuanceAudit.rows[0]?.result === 'denied');

  const issued = await consoleCall('POST', `/console/clients/${client.id}/assist-token`, { origin: 'client_detail' });
  const ttl = new Date(issued.body?.expires_at).getTime() - Date.now();
  check('emite token ast_ con vigencia máxima de 10 minutos',
    issued.status === 200 && /^ast_/.test(issued.body?.token) && ttl > 0 && ttl <= 10 * 60_000);
  const headExchange = await fetch(`${BASE}/v1/portal/auth/assist?token=${encodeURIComponent(issued.body.token)}`, { method: 'HEAD' });
  check('HEAD no consume el token de asistencia', headExchange.status === 405);
  const activated = await fetch(`${BASE}/v1/portal/auth/assist?token=${encodeURIComponent(issued.body.token)}`);
  const activation = await activated.json();
  assistSessionToken = activation.session_token;
  check('canjea el token por sesión aislada', activated.status === 200 && /^asr_/.test(assistSessionToken));
  const replay = await fetch(`${BASE}/v1/portal/auth/assist?token=${encodeURIComponent(issued.body.token)}`);
  check('no permite canjear dos veces el mismo token', replay.status === 401);

  const assistCall = async (method, path, body) => {
    const response = await fetch(`${BASE}/v1/portal${path}`, {
      method,
      headers: {
        'x-856-assist-token': assistSessionToken,
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: response.status, body: await response.json().catch(() => null) };
  };
  const me = await assistCall('GET', '/me');
  check('GET /me usa el contexto del cliente solicitado', me.status === 200 && me.body?.client?.id === client.id && me.body?.assist);
  const balances = await assistCall('GET', '/balances');
  check('GET balances funciona en asistencia', balances.status === 200);
  const activity = await assistCall('GET', '/activity');
  check('GET movimientos funciona en asistencia', activity.status === 200);
  const statement = await assistCall('GET', `/statements/${new Date().toISOString().slice(0, 7)}?asset=${asset}`);
  check('GET estados de cuenta funciona en asistencia', statement.status === 200);
  const obligations = await assistCall('GET', '/obligations');
  check('GET facturas y obligaciones funciona en asistencia', obligations.status === 200);

  const before = await db.query(
    `SELECT (SELECT count(*)::int FROM postings p JOIN accounts a ON a.id = p.account_id WHERE a.client_id = $1) AS postings,
            (SELECT COALESCE(sum(balance), 0)::text FROM accounts WHERE client_id = $1) AS balance`,
    [client.id],
  );
  const deniedExit = await assistCall('POST', '/exits', {});
  const deniedObligation = await assistCall('POST', '/obligations', {});
  const deniedSettings = await assistCall('PATCH', '/users/00000000-0000-4000-8000-000000000000', { active: false });
  check('bloquea POST de retiros antes de procesarlo',
    deniedExit.status === 403 && deniedExit.body?.code === 'operation_not_allowed_in_assist_mode');
  check('bloquea POST de obligaciones antes de procesarlo',
    deniedObligation.status === 403 && deniedObligation.body?.code === 'operation_not_allowed_in_assist_mode');
  check('bloquea PATCH de configuración antes de procesarlo',
    deniedSettings.status === 403 && deniedSettings.body?.code === 'operation_not_allowed_in_assist_mode');
  const after = await db.query(
    `SELECT (SELECT count(*)::int FROM postings p JOIN accounts a ON a.id = p.account_id WHERE a.client_id = $1) AS postings,
            (SELECT COALESCE(sum(balance), 0)::text FROM accounts WHERE client_id = $1) AS balance`,
    [client.id],
  );
  check('las peticiones bloqueadas no alteran postings ni saldos',
    before.rows[0].postings === after.rows[0].postings && before.rows[0].balance === after.rows[0].balance);

  const audit = await db.query(
    `SELECT actor, action, target, metadata->>'result' AS result, metadata->>'trigger' AS trigger
       FROM audit_log WHERE action = 'client_impersonation_initiated' AND target = $1
       ORDER BY id DESC LIMIT 1`,
    [client.id],
  );
  check('registra actor, acción, cliente, resultado y origen en auditoría',
    audit.rows[0]?.actor === `console:${email}` &&
    audit.rows[0]?.result === 'success' &&
    audit.rows[0]?.trigger === 'client_detail');
  const blockedAudit = await db.query(
    `SELECT actor, status FROM audit_log
      WHERE action = 'PORTAL POST /v1/portal/exits' AND client_id = $1
      ORDER BY id DESC LIMIT 1`,
    [client.id],
  );
  check('registra el intento de mutación denegado en la bitácora',
    blockedAudit.rows[0]?.actor === `console:${email}` && blockedAudit.rows[0]?.status === 403);

  await assistCall('GET', '/auth/assist/close');
  const afterClose = await assistCall('GET', '/me');
  check('revoca la sesión al cerrar la pestaña', afterClose.status === 401);
} finally {
  await db.end();
}
