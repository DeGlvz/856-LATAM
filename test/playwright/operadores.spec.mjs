// Consola — administración de operadores en el navegador: 2FA del tesorero, invitación con enlace de un solo uso,
// aceptación en otro contexto, cambio de rol con step-up, desactivar/reactivar, menú por rol y alerta de portal con un solo admin.
// Usa un tesorero propio (create-operator) para no tocar el 2FA del tesorero inicial.
// Capturas opcionales: SHOTS=/ruta/dir (escritorio 1366 y móvil 390).
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test, expect } from '@playwright/test';
import { totp } from '../lib/totp.mjs';

const { KEY, SHOTS } = process.env;
const BASE = process.env.BASE ?? 'http://localhost:8080';
const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const R = Math.random().toString(36).slice(2, 8);
const TES = `pw-optes-${R}@ejemplo.mx`, LEC = `pw-oplec-${R}@ejemplo.mx`, PW = 'clave-playwright-123';
const NEW = `pw-opnew-${R}@ejemplo.mx`, NEW_PW = 'clave-invitado-playwright-1';
const LINK_RE = /https?:\/\/[^\s]+\/console\/invitacion#[A-Za-z0-9_-]+/;
let otp, link, client;

test.describe.configure({ mode: 'serial' });

const createOperator = (email, role) =>
  execFileSync('node', ['dist/scripts/create-operator.js', email, role], { cwd: ROOT, input: PW + '\n', env: process.env, stdio: ['pipe', 'pipe', 'ignore'] });
const shot = async (page, name) => { if (SHOTS) await page.screenshot({ path: `${SHOTS}/a-${name}.png`, fullPage: true }); };
const noHScroll = async (page, w) => expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(w);

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
const row = (page, email) => page.locator(`tr[data-email="${email}"]`);
async function stepUp(page, code = otp.next()) {
  const dlg = page.getByRole('dialog');
  await dlg.getByLabel('Código 2FA para confirmar').fill(await code);
  await dlg.getByRole('button', { name: /Cambiar rol|Desactivar|Reactivar|Revocar|Generar enlace/ }).click();
}

test.beforeAll(async () => {
  createOperator(TES, 'tesorero');
  createOperator(LEC, 'lectura');
  const r = await fetch(`${BASE}/v1/clients`, { method: 'POST', headers: { 'x-api-key': KEY, 'content-type': 'application/json', 'idempotency-key': `pw-op-${R}` },
    body: JSON.stringify({ name: `PW Un Admin ${R}`, assets: ['ETH-SEPOLIA'] }) });
  client = await r.json();
  await fetch(`${BASE}/v1/clients/${client.id}`, { method: 'PATCH', headers: { 'x-api-key': KEY, 'content-type': 'application/json' }, body: JSON.stringify({ status: 'active' }) });
});

test('tesorero sin 2FA: aviso y acciones deshabilitadas; activa su 2FA', async ({ page }) => {
  await login(page, TES, PW);
  await page.getByRole('link', { name: 'Operadores' }).click();
  await expect(page).toHaveURL(/\/console\/operadores$/);
  await expect(page.getByRole('status').filter({ hasText: 'necesita su verificación en dos pasos' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Invitar operador' })).toBeDisabled();
  await page.getByRole('link', { name: 'Activar 2FA en Seguridad' }).click();
  await expect(page).toHaveURL(/\/console\/seguridad$/);
  await expect(page.getByRole('link', { name: 'Administrar operadores' })).toBeVisible();
  await page.getByRole('button', { name: 'Activar 2FA' }).click();
  const secret = (await page.locator('div.font-mono', { hasText: /^[A-Z2-7 ]{20,}/ }).first().innerText()).replace(/\s+/g, '');
  otp = totp(secret);
  await page.getByLabel('Código para activar 2FA').fill(await otp.next());
  await page.getByRole('button', { name: 'Confirmar y activar' }).click();
  await expect(page.getByText('Activa', { exact: true })).toBeVisible();
});

test('invitar operador: el enlace se muestra una sola vez y queda en pendientes', async ({ page }) => {
  await login(page, TES, PW, () => otp.next());
  await page.goto('/console/operadores');
  // Fila propia: acciones deshabilitadas con explicación
  await expect(row(page, TES).getByRole('button', { name: `Desactivar a ${TES}` })).toBeDisabled();
  await expect(row(page, TES).getByLabel(`Cambiar rol de ${TES}`)).toBeDisabled();
  await expect(row(page, TES).locator('[title^="No puede modificarse"]').first()).toBeAttached();

  await page.getByRole('button', { name: 'Invitar operador' }).click();
  const dlg = page.getByRole('dialog');
  await dlg.getByLabel('Correo').fill(NEW);
  await dlg.getByLabel('Rol').selectOption('ejecutivo');
  await stepUp(page, Promise.resolve(otp.wrong()));
  await expect(dlg.getByRole('alert')).toContainText('Código 2FA incorrecto');
  await stepUp(page);
  link = (await dlg.getByTestId('invite-link').textContent()).trim();
  expect(link).toMatch(LINK_RE);
  await expect(dlg).toContainText('se muestra una sola vez');
  await expect(dlg).toContainText('Vence');
  await shot(page, 'operadores-enlace');
  await dlg.getByRole('button', { name: 'Listo' }).click();
  // Al reabrir el diálogo ya no hay enlace: solo el formulario
  await page.getByRole('button', { name: 'Invitar operador' }).click();
  await expect(page.getByRole('dialog').getByTestId('invite-link')).toHaveCount(0);
  await page.getByRole('dialog').getByRole('button', { name: 'Cancelar' }).click();
  await expect(page.getByRole('row', { name: new RegExp(NEW) })).toContainText('Ejecutivo de cuenta');
  // Una segunda invitación al mismo correo: error en español
  await page.getByRole('button', { name: 'Invitar operador' }).click();
  await page.getByRole('dialog').getByLabel('Correo').fill(NEW);
  await stepUp(page);
  await expect(page.getByRole('dialog').getByRole('alert')).toContainText('Ya hay una invitación vigente');
  await page.getByRole('dialog').getByRole('button', { name: 'Cancelar' }).click();
});

test('el invitado acepta en otro contexto, entra y no ve Operadores', async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await page.goto(link);
  await expect(page).toHaveURL(/\/console\/invitacion$/); // el token sale de la barra
  await expect(page.getByText(NEW)).toBeVisible();
  await page.getByLabel('Nombre completo').fill('Invitado Playwright');
  await page.getByLabel('Contraseña', { exact: true }).fill(NEW_PW);
  await page.getByLabel('Confirmar contraseña').fill('otra-cosa-distinta');
  await expect(page.getByText('Las contraseñas no coinciden')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Crear mi acceso' })).toBeDisabled();
  await page.getByLabel('Confirmar contraseña').fill(NEW_PW);
  await page.getByRole('button', { name: 'Crear mi acceso' }).click();
  await expect(page).toHaveURL(/\/console\/login$/);
  await expect(page.getByRole('status')).toContainText('Acceso creado');
  await page.getByLabel('Correo').fill(NEW);
  await page.getByLabel('Contraseña').fill(NEW_PW);
  await page.getByRole('button', { name: 'Entrar' }).click();
  await expect(page.getByRole('heading', { name: 'Tablero' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Operadores' })).toHaveCount(0);
  // El mismo enlace ya no sirve
  const p2 = await (await browser.newContext()).newPage();
  await p2.goto(link);
  await expect(p2.getByRole('alert')).toContainText('no es válida');
});

test('cambiar rol pide código y cierra la sesión del invitado; desactivar y reactivar', async ({ browser }) => {
  const inv = await (await browser.newContext()).newPage();
  await login(inv, NEW, NEW_PW);
  const page = await (await browser.newContext()).newPage();
  await login(page, TES, PW, () => otp.next());
  await page.goto('/console/operadores');
  await expect(row(page, NEW).getByRole('cell').nth(4)).toHaveText(/^[1-9]\d*$/); // sesiones activas (la de la prueba anterior y esta)
  await row(page, NEW).getByLabel(`Cambiar rol de ${NEW}`).selectOption('lectura');
  await expect(page.getByRole('dialog')).toContainText('Sus sesiones abiertas se cierran');
  await stepUp(page);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(row(page, NEW)).toContainText('Lectura');
  await expect(row(page, NEW).getByRole('cell').nth(4)).toHaveText('0');
  // El invitado pierde la sesión
  await inv.reload();
  await expect(inv).toHaveURL(/\/console\/login$/);

  await row(page, NEW).getByRole('button', { name: `Desactivar a ${NEW}` }).click();
  await stepUp(page);
  await expect(row(page, NEW)).toContainText('Desactivado');
  await inv.getByLabel('Correo').fill(NEW);
  await inv.getByLabel('Contraseña').fill(NEW_PW);
  await inv.getByRole('button', { name: 'Entrar' }).click();
  await expect(inv.getByRole('alert')).toContainText('Credenciales inválidas');

  await row(page, NEW).getByRole('button', { name: `Reactivar a ${NEW}` }).click();
  await stepUp(page);
  await expect(row(page, NEW).getByText('Activo', { exact: true }).last()).toBeVisible();
  await login(inv, NEW, NEW_PW);
  await shot(page, 'operadores-escritorio');
});

test('lectura no ve el menú Operadores y la ruta lo regresa al tablero', async ({ page }) => {
  await login(page, LEC, PW);
  await expect(page.getByRole('link', { name: 'Operadores' })).toHaveCount(0);
  await page.goto('/console/operadores');
  await expect(page).toHaveURL(/\/console\/?$/);
  await expect(page.getByRole('heading', { name: 'Tablero' })).toBeVisible();
});

test('alerta: cliente con un solo admin de portal en el Tablero y en el detalle', async ({ page, browser }) => {
  await login(page, TES, PW, () => otp.next());
  await page.goto(`/console/clientes/${client.id}`);
  await page.getByRole('button', { name: 'Invitar primer admin' }).click();
  await page.getByLabel('Correo del administrador').fill(`pw-opadm-${R}@ejemplo.mx`);
  await page.getByRole('button', { name: 'Generar enlace' }).click();
  const plink = (await page.getByTestId('portal-invite-link').textContent()).trim();
  await page.getByRole('button', { name: 'Listo' }).click();

  const p = await (await browser.newContext()).newPage();
  await p.goto(plink);
  await p.getByLabel('Nombre completo').fill('Admin Único');
  await p.getByLabel('Contraseña', { exact: true }).fill('clave-portal-playwright-1');
  await p.getByLabel('Confirmar contraseña').fill('clave-portal-playwright-1');
  await p.getByRole('button', { name: 'Crear mi acceso' }).click();
  await expect(p.getByText('Su usuario quedó activo.')).toBeVisible();

  await page.goto('/console/');
  const card = page.getByRole('region', { name: 'Clientes con un solo admin en el portal' });
  await expect(card).toBeVisible();
  await card.getByRole('link', { name: `PW Un Admin ${R}` }).click();
  await expect(page).toHaveURL(new RegExp(`/console/clientes/${client.id}$`));
  await expect(page.getByRole('status').filter({ hasText: 'un solo administrador' })).toBeVisible();
  await shot(page, 'cliente-un-admin');
});

test('capturas y móvil sin desplazamiento horizontal', async ({ browser }) => {
  for (const [w, h, tag] of [[1366, 860, 'escritorio'], [390, 844, 'movil']]) {
    const page = await (await browser.newContext({ viewport: { width: w, height: h } })).newPage();
    await page.goto('/console/invitacion#token-de-prueba-que-no-existe-0000000000');
    await expect(page.getByRole('alert')).toBeVisible();
    await noHScroll(page, w); await shot(page, `invitacion-invalida-${tag}`);
    await login(page, TES, PW, () => otp.next());
    for (const [path, name] of [['/console/operadores', 'operadores'], ['/console/', 'tablero'], ['/console/seguridad', 'seguridad']]) {
      await page.goto(path);
      await page.waitForLoadState('networkidle');
      await noHScroll(page, w); await shot(page, `${name}-${tag}`);
    }
    await page.goto('/console/operadores');
    await page.getByRole('button', { name: 'Invitar operador' }).click();
    await noHScroll(page, w); await shot(page, `operadores-invitar-${tag}`);
  }
  // Formulario de invitación válido (enlace nuevo, sin aceptarlo)
  const page = await (await browser.newContext({ viewport: { width: 390, height: 844 } })).newPage();
  await login(page, TES, PW, () => otp.next());
  await page.goto('/console/operadores');
  await page.getByRole('button', { name: 'Invitar operador' }).click();
  await page.getByRole('dialog').getByLabel('Correo').fill(`pw-opshot-${R}@ejemplo.mx`);
  await stepUp(page);
  const l = (await page.getByRole('dialog').getByTestId('invite-link').textContent()).trim();
  await noHScroll(page, 390); await shot(page, 'operadores-enlace-movil');
  const p = await (await browser.newContext({ viewport: { width: 390, height: 844 } })).newPage();
  await p.goto(l);
  await expect(p.getByLabel('Nombre completo')).toBeVisible();
  await noHScroll(p, 390); await shot(p, 'invitacion-movil');
  await p.setViewportSize({ width: 1366, height: 860 });
  await shot(p, 'invitacion-escritorio');
});
