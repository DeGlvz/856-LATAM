import { test, expect } from '@playwright/test';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

let server, origin;
const dist = fileURLToPath(new URL('../../web/dist/', import.meta.url));
test.beforeAll(async () => {
  server = createServer(async (req, res) => {
    const relative = new URL(req.url, 'http://localhost').pathname.replace(/^\/console\/?/, '');
    const file = path.resolve(dist, relative.startsWith('assets/') ? relative : 'index.html');
    if (!file.startsWith(dist)) { res.writeHead(403).end(); return; }
    try {
      const content = await readFile(file);
      res.setHeader('content-type', file.endsWith('.js') ? 'application/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html');
      res.end(content);
    } catch { res.writeHead(404).end(); }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
});
test.afterAll(async () => { await new Promise((resolve) => server.close(resolve)); });

async function mockApi(page, { role = 'ejecutivo', enabled = true, totp = true, firstRunDisconnect = false } = {}) {
  const clientId = '00000000-0000-4000-8000-000000000001';
  let detail = {
    client: { id: clientId, name: 'Cliente Worker A', status: 'active' },
    policy: { mode: 'manual', interval_minutes: 1440, timezone: 'UTC', windows: [], revision: 0, next_due_at: null },
    runs: [], usage: [], worker_enabled: enabled, setup_required: false,
  };
  const saved = [], runs = [], requests = [];
  await page.route('**/v1/**', async (route) => {
    const request = route.request(), url = new URL(request.url());
    requests.push(url.pathname);
    let body, status = 200;
    if (url.pathname === '/v1/meta') body = { environment: 'sandbox', setup_required: false };
    else if (url.pathname === '/v1/auth/me') body = { operator: { id: 'op', email: 'worker@example.test', name: 'Ejecutivo', role, totp_enabled: totp } };
    else if (url.pathname === '/v1/console/worker/clients') body = { clients: [{ ...detail.client, mode: detail.policy.mode }] };
    else if (url.pathname.endsWith('/policy')) {
      const payload = request.postDataJSON();
      saved.push(payload);
      detail = { ...detail, policy: { ...detail.policy, ...payload.policy, revision: detail.policy.revision + 1,
        next_due_at: payload.policy.mode === 'manual' ? null : '2026-10-25T09:00:00Z' } };
      body = detail;
    } else if (url.pathname.endsWith('/run')) {
      runs.push({ ...request.postDataJSON(), headers: request.headers() });
      const run = { id: 'run-1', trigger: 'manual', started_at: '2026-10-24T09:00:00Z', finished_at: '2026-10-24T09:00:01Z',
        status: 'error', error: 'Alchemy Notify 503: test failure', networks: { 'eth-sepolia': { sign: 'ok', webhook: 'error: 503', sweep: 'ok' } } };
      detail = { ...detail, runs: [run], usage: [{ metric: `client:${clientId}:manual`, qty: '1' }] };
      if (firstRunDisconnect && runs.length === 1) {
        detail = { ...detail, policy: { ...detail.policy, revision: 1 } };
        await route.abort();
        return;
      }
      body = run;
    } else if (url.pathname === `/v1/console/worker/clients/${clientId}`) body = detail;
    else { status = 503; body = { error: 'Not available in isolated panel test' }; }
    await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
  });
  return { clientId, saved, runs, requests };
}

test('executive configures default manual, automatic interval and explicit UTC windows then executes one client', async ({ page }) => {
  const state = await mockApi(page);
  await page.goto(`${origin}/console/worker`);
  await expect(page.getByRole('heading', { name: 'Control del worker' })).toBeVisible();
  await page.getByLabel('Cliente', { exact: true }).selectOption(state.clientId);
  await expect(page.getByText('Sin ejecuciones. Los clientes sin política usan Manual.')).toBeVisible();
  await expect(page.getByLabel('Modo', { exact: true })).toHaveValue('manual');
  await page.getByLabel('Modo', { exact: true }).selectOption('automatic');
  await expect(page.getByLabel('Intervalo real del worker (minutos)')).toHaveValue('1440');
  await page.getByLabel('Intervalo real del worker (minutos)').fill('45');
  await page.getByLabel('Código 2FA de un solo uso').fill('123456');
  await page.getByRole('button', { name: 'Guardar política' }).click();
  await expect.poll(() => state.saved.length).toBe(1);
  expect(state.saved[0].policy).toEqual({ mode: 'automatic', interval_minutes: 45, timezone: 'UTC', windows: [] });
  await expect(page.getByText('Próxima ejecución: 2026-10-25 09:00:00 UTC')).toBeVisible();
  await page.getByLabel('Modo', { exact: true }).selectOption('scheduled');
  await page.getByRole('button', { name: 'Agregar ventana' }).click();
  await expect(page.getByLabel('Inicio UTC', { exact: true })).toHaveValue('09:00');
  await expect(page.getByLabel('Zona horaria')).toHaveValue('UTC');
  await page.getByLabel('Código 2FA de un solo uso').fill('234567');
  await page.getByRole('button', { name: 'Guardar política' }).click();
  await expect.poll(() => state.saved.length).toBe(2);
  expect(state.saved[1].policy.windows).toEqual([{ days: [1, 2, 3, 4, 5], start: '09:00', end: '10:00' }]);
  await expect(page.getByLabel('Código 2FA de un solo uso')).toHaveValue('');
  await page.getByLabel('Código 2FA de un solo uso').fill('345678');
  await page.getByRole('button', { name: 'Ejecutar este cliente' }).click();
  await expect.poll(() => state.runs.length).toBe(1);
  expect(state.runs[0].request_id).toMatch(/^[0-9a-f-]{36}$/);
  expect(state.runs[0].headers['x-856-console']).toBe('1');
  await expect(page.getByText('Alchemy Notify 503: test failure', { exact: true })).toBeVisible();
  await expect(page.getByText('Intentos iniciados este mes: 1.', { exact: false })).toBeVisible();
  expect(state.requests).not.toContain('/v1/worker/tick');
});

test('read-only operator has no panel navigation or API query', async ({ page }) => {
  const state = await mockApi(page, { role: 'lectura' });
  await page.goto(`${origin}/console/worker`);
  await expect(page).toHaveURL(`${origin}/console`);
  await expect(page.getByRole('link', { name: 'Control del worker' })).toHaveCount(0);
  expect(state.requests.some((p) => p.startsWith('/v1/console/worker'))).toBe(false);
});

test('global disable and missing 2FA cannot trigger execution in UI', async ({ page }) => {
  const state = await mockApi(page, { enabled: false, totp: false });
  await page.goto(`${origin}/console/worker`);
  await page.getByLabel('Cliente', { exact: true }).selectOption(state.clientId);
  await expect(page.getByText(/Disparos bloqueados: worker deshabilitado globalmente/)).toBeVisible();
  await page.getByLabel('Código 2FA de un solo uso').fill('123456');
  await expect(page.getByRole('button', { name: 'Ejecutar este cliente' })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Guardar política' })).toBeDisabled();
  expect(state.runs.length).toBe(0);
});

test('retry after a lost response retains request ID even when default policy was materialized', async ({ page }) => {
  const state = await mockApi(page, { firstRunDisconnect: true });
  await page.goto(`${origin}/console/worker`);
  await page.getByLabel('Cliente', { exact: true }).selectOption(state.clientId);
  await page.getByLabel('Código 2FA de un solo uso').fill('123456');
  await page.getByRole('button', { name: 'Ejecutar este cliente' }).click();
  await expect.poll(() => state.runs.length).toBe(1);
  await expect(page.getByLabel('Código 2FA de un solo uso')).toHaveValue('');
  await expect(page.getByText('Alchemy Notify 503: test failure', { exact: true })).toBeVisible();
  await page.getByLabel('Código 2FA de un solo uso').fill('234567');
  await page.getByRole('button', { name: 'Ejecutar este cliente' }).click();
  await expect.poll(() => state.runs.length).toBe(2);
  expect(state.runs[1].request_id).toBe(state.runs[0].request_id);
});
