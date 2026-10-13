// Recorridos reales de la consola en el navegador: login, 2FA, doble aprobación (retiro y corrida) y auditoría.
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { test, expect } from '@playwright/test';
import { totp } from '../lib/totp.mjs';

const { KEY, BOOT_EMAIL, BOOT_PASS } = process.env;
const BASE = process.env.BASE ?? 'http://localhost:8080';
const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const R = Math.random().toString(36).slice(2, 8);
const T2 = `pw-tes-${R}@ejemplo.mx`, LEC = `pw-lec-${R}@ejemplo.mx`, PW = 'clave-playwright-123';
let otp; // generador TOTP del tesorero 2 (lo llena la prueba de alta de 2FA)

test.describe.configure({ mode: 'serial' });

const createOperator = (email, role) =>
  execFileSync('node', ['dist/scripts/create-operator.js', email, role], { cwd: ROOT, input: PW + '\n', env: process.env, stdio: ['pipe', 'pipe', 'ignore'] });
const api = async (method, path, body, idem) => {
  const r = await fetch(BASE + path, { method, headers: { 'x-api-key': KEY, 'content-type': 'application/json', ...(idem ? { 'idempotency-key': `${idem}-${R}` } : {}) }, body: body && JSON.stringify(body) });
  return r.json();
};

async function login(page, email, password, code) {
  await page.goto('/console/login');
  await page.getByLabel('Correo').fill(email);
  await page.getByLabel('Contraseña').fill(password);
  await page.getByRole('button', { name: 'Entrar' }).click();
  if (code) {
    await page.getByLabel('Código de su app de autenticación').fill(await code());
    await page.getByRole('button', { name: 'Verificar' }).click();
  }
  await expect(page.getByRole('button', { name: 'Salir' })).toBeVisible();
}
const consolePost = (page, path, body, idem) => page.request.post(`/v1${path}`, {
  headers: { 'x-856-console': '1', 'content-type': 'application/json', ...(idem ? { 'idempotency-key': `${idem}-${R}` } : {}) }, data: body,
});

// Datos: cliente activo con ETH, lista blanca; tres clientes con obligaciones en ciclo
let client, A, B, C;
test.beforeAll(async () => {
  createOperator(T2, 'tesorero');
  createOperator(LEC, 'lectura');
  const DEST = '0x' + randomBytes(20).toString('hex'); // única por corrida: una dirección no se repite entre clientes
  client = await api('POST', '/v1/clients', { name: `PW Retiro ${R}`, assets: ['ETH-SEPOLIA'] }, 'c');
  await api('PATCH', `/v1/clients/${client.id}`, { status: 'active' });
  await api('POST', '/v1/wallets', { client_id: client.id, chain: 'ethereum', network: 'eth-sepolia', address: DEST, purpose: 'withdrawal_whitelist' });
  const acc = (await api('GET', `/v1/clients/${client.id}`)).accounts[0].id;
  await api('POST', '/v1/entries', { kind: 'deposit', postings: [
    { account: 'system:ETH-SEPOLIA:custody', direction: 'debit', amount: '20000000000000000' }, { account: acc, direction: 'credit', amount: '20000000000000000' }] }, 'f');
  client.dest = DEST;
  const mk = async (n) => { const c = await api('POST', '/v1/clients', { name: `PW ${n} ${R}`, assets: ['USDC-ETH-SEPOLIA'] }, `c${n}`); await api('PATCH', `/v1/clients/${c.id}`, { status: 'active' }); return c; };
  [A, B, C] = [await mk('A'), await mk('B'), await mk('C')];
  const accA = (await api('GET', `/v1/clients/${A.id}`)).accounts[0].id;
  await api('POST', '/v1/entries', { kind: 'deposit', postings: [
    { account: 'system:USDC-ETH-SEPOLIA:custody', direction: 'debit', amount: '10000000' }, { account: accA, direction: 'credit', amount: '10000000' }] }, 'fA');
  const ob = (d, c, amount, ref) => api('POST', '/v1/obligations', { debtor_id: d.id, creditor_id: c.id, asset_id: 'USDC-ETH-SEPOLIA', amount, external_ref: ref }, ref);
  await ob(A, B, '5000000', `PW1-${R}`); await ob(B, C, '5000000', `PW2-${R}`); await ob(C, A, '4000000', `PW3-${R}`);
});

test('login: credenciales incorrectas muestran error y las correctas abren el tablero', async ({ page }) => {
  await page.goto('/console/login');
  await page.getByLabel('Correo').fill(BOOT_EMAIL);
  await page.getByLabel('Contraseña').fill('no-es-la-clave');
  await page.getByRole('button', { name: 'Entrar' }).click();
  await expect(page.getByRole('alert')).toContainText('Credenciales inválidas');
  await login(page, BOOT_EMAIL, BOOT_PASS);
  await expect(page.getByRole('link', { name: /Aprobaciones/ })).toBeVisible();
});

test('2FA: alta con QR y clave, y login en dos pasos', async ({ page }) => {
  await login(page, T2, PW);
  await page.getByRole('link', { name: 'Seguridad' }).first().click();
  await page.getByRole('button', { name: 'Activar 2FA' }).click();
  await expect(page.getByAltText('Código QR para la app de autenticación')).toBeVisible();
  const secret = (await page.locator('div.font-mono', { hasText: /^[A-Z2-7 ]{20,}/ }).first().innerText()).replace(/\s+/g, '');
  expect(secret).toMatch(/^[A-Z2-7]{32}$/);
  otp = totp(secret);
  await page.getByLabel('Código para activar 2FA').fill(otp.wrong());
  await page.getByRole('button', { name: 'Confirmar y activar' }).click();
  await expect(page.getByRole('alert')).toContainText('Código incorrecto');
  await page.getByLabel('Código para activar 2FA').fill(await otp.next());
  await page.getByRole('button', { name: 'Confirmar y activar' }).click();
  await expect(page.getByText('Activa', { exact: true })).toBeVisible();

  await page.getByRole('button', { name: 'Salir' }).click();
  await page.getByLabel('Correo').fill(T2);
  await page.getByLabel('Contraseña').fill(PW);
  await page.getByRole('button', { name: 'Entrar' }).click();
  await expect(page.getByText('Verificación en dos pasos')).toBeVisible();
  await page.getByLabel('Código de su app de autenticación').fill(otp.wrong());
  await page.getByRole('button', { name: 'Verificar' }).click();
  await expect(page.getByRole('alert')).toContainText('Código incorrecto');
  await page.getByLabel('Código de su app de autenticación').fill(await otp.next());
  await page.getByRole('button', { name: 'Verificar' }).click();
  await expect(page.getByRole('button', { name: 'Salir' })).toBeVisible();
});

test('retiro: el solicitante no puede aprobar; el segundo tesorero aprueba con 2FA', async ({ browser }) => {
  const p1 = await (await browser.newContext()).newPage();
  await login(p1, BOOT_EMAIL, BOOT_PASS);
  const r = await consolePost(p1, '/withdrawals', { client_id: client.id, asset_id: 'ETH-SEPOLIA', to_address: client.dest, amount: '1000000000000000' }, 'wd');
  expect(r.status(), await r.text()).toBe(202);
  const wd = await r.json();
  expect(wd.approval_status).toBe('pending');

  await p1.getByRole('link', { name: /Aprobaciones/ }).click();
  const card1 = p1.locator('div.rounded-lg.border', { hasText: `PW Retiro ${R}` });
  await expect(card1).toContainText('Usted lo solicitó');
  await p1.goto('/console/movimientos');
  await expect(p1.getByRole('row', { name: new RegExp(`PW Retiro ${R}`) }).getByText('Por aprobar')).toBeVisible();

  const p2 = await (await browser.newContext()).newPage();
  await login(p2, T2, PW, () => otp.next());
  await expect(p2.getByRole('link', { name: /Aprobaciones/ })).toContainText(/\d/); // contador de pendientes
  await p2.getByRole('link', { name: /Aprobaciones/ }).click();
  const card2 = p2.locator('div.rounded-lg.border', { hasText: `PW Retiro ${R}` });
  await card2.getByLabel('Código 2FA para aprobar el retiro').fill(otp.wrong());
  await card2.getByRole('button', { name: 'Aprobar retiro' }).click();
  await expect(card2.getByRole('alert')).toContainText('incorrecto');
  await card2.getByLabel('Código 2FA para aprobar el retiro').fill(await otp.next());
  await card2.getByRole('button', { name: 'Aprobar retiro' }).click();
  await expect(p2.locator('div.rounded-lg.border', { hasText: `PW Retiro ${R}` })).toHaveCount(0);
  const after = await (await p2.request.get(`/v1/withdrawals/${wd.id}`)).json();
  expect(after.approval_status).toBe('approved');
  expect(after.approved_by).toBe(T2);
});

test('compensación: simular selección, solicitar y aprobar en otra sesión', async ({ browser }) => {
  const p1 = await (await browser.newContext()).newPage();
  await login(p1, BOOT_EMAIL, BOOT_PASS);
  await p1.goto(`/console/compensacion?asset=USDC-ETH-SEPOLIA&ref=${R}`);
  for (const ref of ['PW1', 'PW2', 'PW3']) await p1.getByLabel(`Seleccionar obligación ${ref}-${R}`).check();
  await p1.getByRole('button', { name: 'Simular selección' }).click();
  await p1.getByRole('button', { name: 'Simular', exact: true }).click();
  await expect(p1.getByText('Neto a mover')).toBeVisible();
  await p1.getByRole('button', { name: 'Solicitar liquidación…' }).click();
  await p1.getByRole('button', { name: 'Solicitar liquidación', exact: true }).click();
  const dlg = p1.getByRole('dialog');
  await expect(dlg).toContainText('Por aprobar');
  await expect(dlg).toContainText('Usted lo solicitó');
  await expect(dlg).toContainText('Simulación vigente');
  const runId = (await dlg.locator('p, div').filter({ hasText: /^[0-9a-f-]{36}$/ }).first().innerText()).trim();
  await p1.keyboard.press('Escape');

  const p2 = await (await browser.newContext()).newPage();
  await login(p2, T2, PW, () => otp.next());
  await p2.goto('/console/aprobaciones');
  const card = p2.locator('div.rounded-lg.border', { hasText: `Corrida ${runId.slice(0, 8)}` });
  await card.getByLabel('Código 2FA para aprobar la corrida').fill(await otp.next());
  await card.getByRole('button', { name: 'Aprobar corrida' }).click();
  await expect(card).toHaveCount(0);
  const run = await (await p2.request.get(`/v1/netting/runs/${runId}`)).json();
  expect(`${run.status} ${run.approved_by}`).toBe(`settled ${T2}`);

  await p1.goto('/console/compensacion?tab=corridas&asset=USDC-ETH-SEPOLIA');
  await expect(p1.getByRole('row', { name: new RegExp(runId.slice(0, 8)) })).toContainText('Liquidada');
});

test('auditoría: tesorería filtra la bitácora; lectura no la ve', async ({ page, browser }) => {
  await login(page, BOOT_EMAIL, BOOT_PASS);
  await page.getByRole('link', { name: 'Auditoría' }).click();
  await page.getByLabel('Acción').selectOption('POST /v1/withdrawals/:id/approve');
  await expect(page.getByRole('row', { name: new RegExp(T2) }).first()).toBeVisible();
  await page.getByLabel('Resultado').selectOption('denied');
  await expect(page.getByRole('cell', { name: 'Denegado' }).first()).toBeVisible();
  const dl = page.waitForEvent('download');
  await page.getByRole('button', { name: /Exportar CSV/ }).click();
  expect((await dl).suggestedFilename()).toMatch(/^bitacora-856-.*\.csv$/);

  const pl = await (await browser.newContext()).newPage();
  await login(pl, LEC, PW);
  await expect(pl.getByRole('link', { name: 'Auditoría' })).toHaveCount(0);
  await pl.goto('/console/auditoria');
  await expect(pl.getByRole('alert')).toContainText('Requiere rol tesorero');
});

test('móvil: aprobaciones y auditoría sin desplazamiento horizontal', async ({ browser }) => {
  const page = await (await browser.newContext({ viewport: { width: 390, height: 844 } })).newPage();
  await login(page, BOOT_EMAIL, BOOT_PASS);
  for (const path of ['/console/aprobaciones', '/console/auditoria', '/console/seguridad']) {
    await page.goto(path);
    await page.waitForLoadState('networkidle');
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  }
});
