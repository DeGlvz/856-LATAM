// Portal fase 3 en el navegador: lista blanca (pedir, aprobar con 2FA, espera), nueva salida en cuatro pasos con simulación,
// aprobación interna del cliente arriba de su umbral y, en la consola, «Salidas por validar»: autorizar y rechazar con motivo.
// Funciona con ORIGIN_RULE=off o enforce (no origina nada desde la consola ni con la API key).
// Uso: BASE KEY DATABASE_URL … npx playwright test portal-salidas.spec.mjs
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { test, expect } from '@playwright/test';
import { totp } from '../lib/totp.mjs';

const { KEY, SHOTS, DATABASE_URL } = process.env;
const BASE = process.env.BASE ?? 'http://localhost:8080';
const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const R = Math.random().toString(36).slice(2, 8);
const IP = `10.78.${Math.floor(Math.random() * 250)}`;
const PW = 'clave-portal-salidas-1';
const ETH = 'ETH-SEPOLIA';
const DEST = '0x' + randomBytes(20).toString('hex');
const TES = `pw-sal-tes-${R}@ejemplo.mx`;
let A, adm, opr, apr, tesOtp;

test.describe.configure({ mode: 'serial' });
const shot = async (page, name) => { if (SHOTS) await page.screenshot({ path: `${SHOTS}/c-${name}.png`, fullPage: true }); };
const sql = (q) => execFileSync('psql', [DATABASE_URL, '-qAtc', q], { encoding: 'utf8' }).trim();
const api = async (method, path, body, idem) => {
  const r = await fetch(BASE + path, { method, headers: { 'x-api-key': KEY, 'content-type': 'application/json', ...(idem ? { 'idempotency-key': `pws-${idem}-${R}` } : {}) }, body: body && JSON.stringify(body) });
  return r.json();
};
function session(base, ip, csrf) {
  let cookie = null;
  const call = async (method, path, body) => {
    const r = await fetch(`${BASE}${base}${path}`, { method, headers: { 'x-forwarded-for': ip, ...(body ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}), ...(method !== 'GET' ? { [csrf]: '1' } : {}) }, body: body && JSON.stringify(body) });
    const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
    return r.json().catch(() => null);
  };
  return { call };
}
async function user(role, n, inviter) {
  const email = `pws-${role}-${n}-${R}@ejemplo.mx`;
  const inv = inviter ? await inviter.s.call('POST', '/users/invites', { email, role }) : await api('POST', `/v1/clients/${A.id}/portal-invite`, { email });
  const s = session('/v1/portal', `${IP}.${n}`, 'x-856-portal');
  await s.call('POST', '/invites/accept', { token: inv.link.split('#')[1], name: `Usuario ${role} ${n}`, password: PW });
  await s.call('POST', '/auth/login', { email, password: PW });
  let otp = null;
  if (role === 'admin' || role === 'approver') { const st = await s.call('POST', '/auth/totp/setup', {}); otp = totp(st.secret); await s.call('POST', '/auth/totp/enable', { code: await otp.next() }); }
  return { email, s, otp, ip: `${IP}.${n}` };
}

test.beforeAll(async () => {
  A = await api('POST', '/v1/clients', { name: `Salidas Alfa ${R}`, assets: [ETH] }, 'a');
  await api('PATCH', `/v1/clients/${A.id}`, { status: 'active' });
  await api('POST', '/v1/entries', { kind: 'adjustment', description: 'fondeo', postings: [
    { account: `client:${A.id}:${ETH}:available`, direction: 'credit', amount: '20000000000000000' },
    { account: `system:${ETH}:custody`, direction: 'debit', amount: '20000000000000000' }] }, 'f');
  adm = await user('admin', 1);
  opr = await user('operator', 2, adm);
  apr = await user('approver', 3, adm);
  // Tesorero de 856 con 2FA (el alta del secreto va por API; en el navegador solo se teclea el código)
  execFileSync('node', ['dist/scripts/create-operator.js', TES, 'tesorero'], { cwd: ROOT, input: PW + '\n', env: process.env, stdio: ['pipe', 'pipe', 'ignore'] });
  const t = session('/v1', `${IP}.20`, 'x-856-console');
  await t.call('POST', '/auth/login', { email: TES, password: PW });
  const st = await t.call('POST', '/auth/totp/setup', {}); tesOtp = totp(st.secret);
  await t.call('POST', '/auth/totp/enable', { code: await tesOtp.next() });
});

async function portalLogin(page, u) {
  // IP de origen propia por usuario: el límite de intentos de login es por IP y todas las pruebas salen de 127.0.0.1
  await page.context().setExtraHTTPHeaders({ 'x-forwarded-for': u.ip });
  await page.goto('/portal/login');
  await page.getByLabel('Correo').fill(u.email);
  await page.getByLabel('Contraseña').fill(PW);
  await page.getByRole('button', { name: 'Entrar' }).click();
  if (u.otp) {
    await page.getByLabel('Código de su app de autenticación').fill(await u.otp.next());
    await page.getByRole('button', { name: 'Verificar' }).click();
  }
  await expect(page.getByRole('button', { name: 'Salir' })).toBeVisible();
}

test('lista blanca: pide el operador, aprueba otro con 2FA y queda en espera', async ({ page, browser }) => {
  await portalLogin(page, opr);
  await page.getByRole('link', { name: 'Lista blanca' }).click();
  await page.getByRole('button', { name: 'Agregar dirección' }).click();
  await page.getByLabel(/^Dirección \(red /).fill(DEST);
  await page.getByLabel('Etiqueta (opcional)').fill('Proveedor PW');
  await page.getByRole('button', { name: 'Solicitar alta' }).click();
  const row = page.locator(`[data-wl="${DEST}"]`);
  await expect(row).toContainText('Por aprobar');
  await expect(row).toContainText('Debe aprobarla otro usuario');
  await expect(row.getByRole('button', { name: 'Aprobar' })).toHaveCount(0);

  const ctx = await browser.newContext(); const p2 = await ctx.newPage();
  await portalLogin(p2, apr);
  await p2.goto('/portal/lista-blanca');
  await p2.locator(`[data-wl="${DEST}"]`).getByRole('button', { name: 'Aprobar' }).click();
  await p2.getByLabel('Código 2FA para aprobar').fill(await apr.otp.next());
  await p2.getByRole('dialog').getByRole('button', { name: 'Aprobar' }).click();
  await expect(p2.locator(`[data-wl="${DEST}"]`)).toContainText('En espera');
  await expect(p2.locator(`[data-wl="${DEST}"]`)).toContainText(/usable en 2[34] h/);
  await shot(p2, 'lista-blanca-espera');
  await ctx.close();

  // Fin de la espera (en pruebas se adelanta en la base)
  sql(`UPDATE wallets SET active_from = now() - interval '1 minute' WHERE address = '${DEST.toLowerCase()}'`);
  await page.reload();
  await expect(row).toContainText('Vigente');
});

test('nueva salida en cuatro pasos: simulación exacta y pasa a validación de 856', async ({ page }) => {
  await portalLogin(page, opr);
  await page.getByRole('link', { name: 'Salidas' }).click();
  await page.getByRole('button', { name: 'Nueva salida' }).click();
  const dlg = page.getByRole('dialog');
  await dlg.getByRole('radio', { name: /ETH/ }).click();
  await dlg.getByRole('button', { name: 'Continuar' }).click();
  await dlg.getByRole('radio', { name: /Proveedor PW/ }).click();
  await dlg.getByRole('button', { name: 'Continuar' }).click();
  await dlg.getByLabel('Monto en ETH').fill('0.0011');
  await dlg.getByRole('button', { name: 'Simular' }).click();
  await expect(dlg.getByTestId('sim-amount')).toContainText('0.0011');
  await expect(dlg).toContainText('Lo paga 856');
  await expect(dlg).toContainText('0.0189'); // quedará
  await shot(page, 'salida-confirmacion');
  await dlg.getByRole('button', { name: 'Confirmar salida' }).click();
  await expect(page).toHaveURL(/\/portal\/salidas\/[0-9a-f-]{36}$/);
  await expect(page.getByText('En validación 856').first()).toBeVisible();
  await expect(page.getByRole('list', { name: 'Seguimiento' })).toContainText('Respuesta estimada antes de');
});

test('arriba del umbral del cliente: el admin lo fija con 2FA y otro usuario aprueba la salida', async ({ page, browser }) => {
  await portalLogin(page, adm);
  await page.goto('/portal/salidas');
  await page.locator(`[data-threshold="${ETH}"]`).getByRole('button', { name: 'Cambiar' }).click();
  await page.getByLabel('Monto en ETH').fill('0.002');
  await page.getByLabel('Código 2FA para el umbral').fill(await adm.otp.next());
  await page.getByRole('button', { name: 'Guardar' }).click();
  await expect(page.locator(`[data-threshold="${ETH}"]`)).toContainText('0.002');

  const ctx = await browser.newContext(); const p2 = await ctx.newPage();
  await portalLogin(p2, opr);
  await p2.goto('/portal/salidas');
  await p2.getByRole('button', { name: 'Nueva salida' }).click();
  const dlg = p2.getByRole('dialog');
  await dlg.getByRole('radio', { name: /ETH/ }).click(); await dlg.getByRole('button', { name: 'Continuar' }).click();
  await dlg.getByRole('radio', { name: /Proveedor PW/ }).click(); await dlg.getByRole('button', { name: 'Continuar' }).click();
  await dlg.getByLabel('Monto en ETH').fill('0.005');
  await dlg.getByRole('button', { name: 'Simular' }).click();
  await dlg.getByRole('button', { name: 'Confirmar salida' }).click();
  await expect(p2.getByText('Aprobación interna').first()).toBeVisible();
  await expect(p2.getByRole('button', { name: 'Aprobar' })).toHaveCount(0); // quien originó no aprueba
  await ctx.close();

  await page.context().clearCookies();
  await portalLogin(page, apr);
  await page.goto('/portal/salidas');
  await page.getByLabel('Filtrar por estado').selectOption('client_approval');
  await page.getByRole('row', { name: /0\.005/ }).getByRole('button', { name: 'Aprobar' }).click();
  await page.getByLabel('Código 2FA para aprobar la salida').fill(await apr.otp.next());
  await page.getByRole('dialog').getByRole('button', { name: 'Aprobar' }).click();
  await page.getByLabel('Filtrar por estado').selectOption('validation');
  await expect(page.getByRole('table', { name: 'Salidas' }).locator('tbody tr')).toHaveCount(2);
  await shot(page, 'salidas-validacion');
});

test('consola: «Salidas por validar» autoriza una y rechaza otra con motivo; el cliente lo ve', async ({ page, browser }) => {
  await page.context().setExtraHTTPHeaders({ 'x-forwarded-for': `${IP}.20` });
  await page.goto('/console/login');
  await page.getByLabel('Correo').fill(TES);
  await page.getByLabel('Contraseña').fill(PW);
  await page.getByRole('button', { name: 'Entrar' }).click();
  await page.getByLabel('Código de su app de autenticación').fill(await tesOtp.next());
  await page.getByRole('button', { name: 'Verificar' }).click();
  await expect(page.getByRole('button', { name: 'Salir' })).toBeVisible();
  await page.goto('/console/aprobaciones');
  const sec = page.locator('[data-section="exits"]');
  await expect(sec).toContainText('Salidas por validar');
  const mine = sec.locator('[data-exit]', { hasText: `Salidas Alfa ${R}` }); // otras corridas pueden dejar pendientes
  const small = mine.filter({ hasText: '0.0011' });
  const big = mine.filter({ hasText: '0.005' });
  await expect(small).toContainText(`Salidas Alfa ${R}`);
  await expect(big).toContainText('Usuario approver 3'); // aprobación interna del cliente
  await expect(page.locator('[data-section="dual-thresholds"]')).toHaveCount(0);
  await shot(page, 'consola-salidas');

  await small.getByLabel('Código 2FA para aprobar la salida').fill(await tesOtp.next());
  await small.getByRole('button', { name: 'Autorizar salida' }).click();
  await expect(small).toHaveCount(0);
  await big.getByRole('button', { name: 'Rechazar…' }).click();
  await big.getByLabel('Motivo del rechazo').fill('Destino en revisión de cumplimiento');
  await big.getByRole('button', { name: 'Rechazar salida' }).click();
  await expect(big).toHaveCount(0);

  const ctx = await browser.newContext(); const p2 = await ctx.newPage();
  await portalLogin(p2, opr);
  await p2.goto('/portal/salidas');
  await expect(p2.getByRole('row', { name: /0\.0011/ })).toContainText('Autorizada');
  await p2.getByRole('row', { name: /0\.005/ }).getByRole('link', { name: 'Ver' }).click();
  await expect(p2.getByText('Rechazada por 856').first()).toBeVisible();
  await expect(p2.getByText('Destino en revisión de cumplimiento').first()).toBeVisible();
  await ctx.close();
});

test('llaves: el admin puede dar permiso de originar salidas a una llave Ed25519', async ({ page }) => {
  await portalLogin(page, adm);
  await page.goto('/portal/llaves');
  await page.getByRole('button', { name: 'Nueva llave' }).click();
  await expect(page.getByLabel('Permitir originar salidas')).toBeVisible();
  await page.getByRole('radio', { name: /Token de solo lectura/ }).click();
  await expect(page.getByLabel('Permitir originar salidas')).toHaveCount(0); // los tokens de lectura nunca originan
});
