// Portal de clientes — fase 2 en el navegador: Inicio con saldos y avisos, Cuentas (historial paginado, CSV y estado de cuenta),
// Depósitos (dirección con QR solo para operador+) y aislamiento entre clientes.
// Datos por API (API key + sesiones de portal por fetch). Uso: BASE KEY … npx playwright test portal-cuentas.spec.mjs
import { readFileSync } from 'node:fs';
import { test, expect } from '@playwright/test';
import { totp } from '../lib/totp.mjs';

const { KEY, SHOTS } = process.env;
const BASE = process.env.BASE ?? 'http://localhost:8080';
const R = Math.random().toString(36).slice(2, 8);
const IP = `10.77.${Math.floor(Math.random() * 250)}`;
const PW = 'clave-portal-cuentas-1';
const USDC = 'USDC-ETH-SEPOLIA', ETH = 'ETH-SEPOLIA';
const N = 55, EACH = 1_000_001n; // 55 movimientos de 1.000001 → paginación (50) y precisión
const BAL = (EACH * BigInt(N)).toString();
const PAY = '2000000';
let A, B, viewerA, operA, viewerB;

test.describe.configure({ mode: 'serial' });
const shot = async (page, name) => { if (SHOTS) await page.screenshot({ path: `${SHOTS}/b-${name}.png`, fullPage: true }); };

const api = async (method, path, body, idem) => {
  const r = await fetch(BASE + path, { method, headers: { 'x-api-key': KEY, 'content-type': 'application/json', ...(idem ? { 'idempotency-key': `pwc-${idem}-${R}` } : {}) }, body: body && JSON.stringify(body) });
  return r.json();
};
function session(ip) {
  let cookie = null;
  const call = async (method, path, body) => {
    const r = await fetch(`${BASE}/v1/portal${path}`, { method, headers: { 'x-forwarded-for': ip, ...(body ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}), ...(method !== 'GET' ? { 'x-856-portal': '1' } : {}) }, body: body && JSON.stringify(body) });
    const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
    return r.json();
  };
  return { call };
}
async function user(clientId, role, n, inviter) {
  const email = `pwc-${role}-${n}-${R}@ejemplo.mx`;
  const inv = inviter ? await inviter.call('POST', '/users/invites', { email, role }) : await api('POST', `/v1/clients/${clientId}/portal-invite`, { email });
  const s = session(`${IP}.${n}`);
  await s.call('POST', '/invites/accept', { token: inv.link.split('#')[1], name: `Usuario ${role} ${n}`, password: PW });
  await s.call('POST', '/auth/login', { email, password: PW });
  if (role === 'admin') { const st = await s.call('POST', '/auth/totp/setup', {}); await s.call('POST', '/auth/totp/enable', { code: await totp(st.secret).next() }); }
  return { email, s };
}

test.beforeAll(async () => {
  A = await api('POST', '/v1/clients', { name: `Cuentas Alfa ${R}`, assets: [USDC, ETH] }, 'a');
  B = await api('POST', '/v1/clients', { name: `Cuentas Beta ${R}`, assets: [USDC] }, 'b');
  await api('PATCH', `/v1/clients/${A.id}`, { status: 'active' });
  const admA = await user(A.id, 'admin', 1);
  viewerA = await user(A.id, 'viewer', 2, admA.s);
  operA = await user(A.id, 'operator', 3, admA.s);
  const admB = await user(B.id, 'admin', 4);
  viewerB = await user(B.id, 'viewer', 5, admB.s);
  for (let i = 0; i < N; i++) {
    await api('POST', '/v1/entries', { kind: 'adjustment', description: `fondeo ${i}`, postings: [
      { account: `client:${A.id}:${USDC}:available`, direction: 'credit', amount: EACH.toString() },
      { account: `system:${USDC}:custody`, direction: 'debit', amount: EACH.toString() }] }, `e${i}`);
  }
  await api('POST', '/v1/obligations', { debtor_id: A.id, creditor_id: B.id, asset_id: USDC, amount: PAY, external_ref: `OC-${R}` }, 'o1');
});

async function login(page, email) {
  await page.goto('/portal/login');
  await page.getByLabel('Correo').fill(email);
  await page.getByLabel('Contraseña').fill(PW);
  await page.getByRole('button', { name: 'Entrar' }).click();
  await expect(page.getByRole('button', { name: 'Salir' })).toBeVisible();
}

test('Inicio: saldos exactos, por pagar y avisos', async ({ page }) => {
  await login(page, viewerA.email);
  const card = page.locator(`[data-asset="${USDC}"]`);
  await expect(card).toContainText('55.000055');
  await expect(card.locator('dd').nth(3)).toContainText('2'); // por pagar
  await expect(page.locator('[data-code="admins_below_minimum"]')).toBeVisible();
  await expect(page.getByText('Movimientos recientes', { exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Usuarios' })).toHaveCount(0); // viewer no administra
  await shot(page, 'inicio');
});

test('Cuentas: historial paginado, CSV exacto y estado de cuenta que cuadra', async ({ page }) => {
  await login(page, viewerA.email);
  await page.getByRole('link', { name: 'Cuentas' }).first().click();
  await page.locator('tr', { hasText: USDC }).getByRole('link', { name: 'Abrir' }).click();
  await expect(page).toHaveURL(new RegExp(`/portal/cuentas/${USDC}$`));
  const rows = page.getByRole('table', { name: 'Movimientos de la cuenta' }).first().locator('tbody tr');
  await expect(rows).toHaveCount(50);
  await page.getByRole('button', { name: 'Cargar más' }).click();
  await expect(rows).toHaveCount(N);
  await expect(page.getByRole('button', { name: 'Cargar más' })).toHaveCount(0);

  const dl = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Descargar CSV' }).click();
  const d = await dl;
  expect(d.suggestedFilename()).toBe(`movimientos-${USDC}.csv`);
  const csv = readFileSync(await d.path(), 'utf8');
  expect(csv.charCodeAt(0)).toBe(0xfeff); // BOM para Excel
  const lines = csv.trim().split(/\r\n/);
  expect(lines[0]).toContain('Fecha (UTC),Concepto');
  expect(lines.length).toBe(N + 1);
  expect(lines.at(-1)).toContain('55.000055'); // saldo final con todos los decimales

  const st = page.locator('dl[aria-label="Resumen del estado de cuenta"]');
  await expect(st).toContainText('Saldo inicial');
  await expect(st.locator('dd').nth(0)).toHaveText('0');
  await expect(st.locator('dd').nth(1)).toHaveText('55.000055');
  await expect(st.locator('dd').nth(3)).toHaveText('55.000055');
  await shot(page, 'cuenta');
});

test('Depósitos: el viewer no genera; el operador genera una dirección con QR', async ({ page, browser }) => {
  await login(page, viewerA.email);
  await page.goto('/portal/depositos');
  await expect(page.getByRole('heading', { name: 'Depósitos', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Generar nueva dirección' })).toHaveCount(0);

  const p = await (await browser.newContext()).newPage();
  await login(p, operA.email);
  await p.goto('/portal/depositos');
  await p.getByRole('button', { name: 'Generar nueva dirección' }).click();
  await expect(p.getByRole('dialog')).toContainText('siguen recibiendo');
  await p.getByRole('dialog').getByRole('button', { name: 'Generar' }).click();
  await expect(p.getByRole('dialog')).toHaveCount(0);
  const addr = p.locator('[data-address]').first();
  await expect(addr).toBeVisible();
  await expect(addr.getByRole('img', { name: /Código QR de 0x/ })).toBeVisible();
  expect(await addr.getAttribute('data-address')).toMatch(/^0x[0-9a-fA-F]{40}$/);
  await shot(p, 'depositos');
});

test('Aislamiento: otro cliente no ve la cuenta ni los movimientos de A', async ({ page }) => {
  await login(page, viewerB.email);
  await page.goto(`/portal/cuentas/${ETH}`);
  await expect(page.getByRole('alert')).toContainText('No se encontró la cuenta');
  await page.goto(`/portal/cuentas/${USDC}`);
  await expect(page.getByText('Sin movimientos en este periodo.')).toBeVisible();
  await expect(page.getByText('55.000055')).toHaveCount(0);
  await page.goto('/portal/depositos');
  await expect(page.locator('[data-address]')).toHaveCount(0);
});

test('Móvil: Inicio, Cuentas y Depósitos sin desplazamiento horizontal', async ({ browser }) => {
  const page = await (await browser.newContext({ viewport: { width: 390, height: 844 } })).newPage();
  await login(page, operA.email);
  for (const [path, name] of [['/portal', 'inicio-movil'], [`/portal/cuentas/${USDC}`, 'cuenta-movil'], ['/portal/depositos', 'depositos-movil']]) {
    await page.goto(path);
    await page.waitForLoadState('networkidle');
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
    await shot(page, name);
  }
});
