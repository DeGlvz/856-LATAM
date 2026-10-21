// Multi-red (ola 1) en el navegador: tablero por red, activos habilitados por cliente (el Tesorero aplica con 2FA,
// el Ejecutivo solicita y otro aprueba), depósitos en revisión que el Tesorero acredita, y en el portal:
// insignia «Solo salida», dirección de depósito por red y lista blanca con red.
// Requiere el API con dos redes encendidas (NETWORKS=eth-sepolia,base-sepolia).
// Uso: BASE KEY DATABASE_URL … npx playwright test multired.spec.mjs
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { test, expect } from '@playwright/test';
import { totp } from '../lib/totp.mjs';

const { KEY, SHOTS, DATABASE_URL } = process.env;
const BASE = process.env.BASE ?? 'http://localhost:8080';
const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const R = Math.random().toString(36).slice(2, 8);
const IP = `10.79.${Math.floor(Math.random() * 250)}`;
const PW = 'clave-multired-pw-1';
const DEST = '0x' + randomBytes(20).toString('hex');
const TES = { email: `pw-mr-tes-${R}@ejemplo.mx`, ip: `${IP}.20` };
const EJE = { email: `pw-mr-eje-${R}@ejemplo.mx`, ip: `${IP}.21` };
let A, adm, baseWalletId;

test.describe.configure({ mode: 'serial' });
const shot = async (page, name) => { if (SHOTS) await page.screenshot({ path: `${SHOTS}/mr-${name}.png`, fullPage: true }); };
const sql = (q) => execFileSync('psql', [DATABASE_URL, '-qAtc', q], { encoding: 'utf8' }).trim();
const api = async (method, path, body, idem) => {
  const r = await fetch(BASE + path, { method, headers: { 'x-api-key': KEY, 'content-type': 'application/json', ...(idem ? { 'idempotency-key': `pwmr-${idem}-${R}` } : {}) }, body: body && JSON.stringify(body) });
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
/** Operador de 856 con 2FA (el secreto se da de alta por API; en el navegador solo se teclea el código). */
async function operator(u, role) {
  execFileSync('node', ['dist/scripts/create-operator.js', u.email, role], { cwd: ROOT, input: PW + '\n', env: process.env, stdio: ['pipe', 'pipe', 'ignore'] });
  const s = session('/v1', u.ip, 'x-856-console');
  await s.call('POST', '/auth/login', { email: u.email, password: PW });
  const st = await s.call('POST', '/auth/totp/setup', {}); u.otp = totp(st.secret);
  await s.call('POST', '/auth/totp/enable', { code: await u.otp.next() });
}
async function consoleLogin(page, u) {
  await page.context().setExtraHTTPHeaders({ 'x-forwarded-for': u.ip });
  await page.goto('/console/login');
  await page.getByLabel('Correo').fill(u.email);
  await page.getByLabel('Contraseña').fill(PW);
  await page.getByRole('button', { name: 'Entrar' }).click();
  await page.getByLabel('Código de su app de autenticación').fill(await u.otp.next());
  await page.getByRole('button', { name: 'Verificar' }).click();
  await expect(page.getByRole('button', { name: 'Salir' })).toBeVisible();
}
async function portalLogin(page, u) {
  await page.context().setExtraHTTPHeaders({ 'x-forwarded-for': u.ip });
  await page.goto('/portal/login');
  await page.getByLabel('Correo').fill(u.email);
  await page.getByLabel('Contraseña').fill(PW);
  await page.getByRole('button', { name: 'Entrar' }).click();
  await page.getByLabel('Código de su app de autenticación').fill(await u.otp.next());
  await page.getByRole('button', { name: 'Verificar' }).click();
  await expect(page.getByRole('button', { name: 'Salir' })).toBeVisible();
}

test.beforeAll(async () => {
  A = await api('POST', '/v1/clients', { name: `Multired Alfa ${R}` }, 'a');
  await api('PATCH', `/v1/clients/${A.id}`, { status: 'active' });
  await operator(TES, 'tesorero');
  await operator(EJE, 'ejecutivo');
  const email = `pw-mr-adm-${R}@ejemplo.mx`;
  const inv = await api('POST', `/v1/clients/${A.id}/portal-invite`, { email });
  const s = session('/v1/portal', `${IP}.1`, 'x-856-portal');
  await s.call('POST', '/invites/accept', { token: inv.link.split('#')[1], name: 'Admin Multired', password: PW });
  await s.call('POST', '/auth/login', { email, password: PW });
  const st = await s.call('POST', '/auth/totp/setup', {}); const otp = totp(st.secret);
  await s.call('POST', '/auth/totp/enable', { code: await otp.next() });
  adm = { email, otp, ip: `${IP}.1` };
});

test('tablero: una fila por red encendida', async ({ page }) => {
  await consoleLogin(page, TES);
  const sec = page.locator('[data-section="networks"]');
  await expect(sec).toContainText('Redes');
  await expect(sec.locator('[data-network="eth-sepolia"]')).toContainText('Ethereum Sepolia');
  await expect(sec.locator('[data-network="eth-sepolia"]')).toContainText('Principal');
  await expect(sec.locator('[data-network="base-sepolia"]')).toContainText('Base Sepolia');
  await expect(page.getByText(/de 2 redes operando/)).toBeVisible();
  await shot(page, 'tablero');
});

test('activos del cliente: edición individual y por red conservan 2FA', async ({ page }) => {
  const oldWallet = await api('POST', `/v1/clients/${A.id}/deposit-address`, { network: 'base-sepolia' });
  baseWalletId = oldWallet.wallet_id;
  const unusedWallet = await api('POST', `/v1/clients/${A.id}/deposit-address`, { network: 'base-sepolia', rotate: true });
  await consoleLogin(page, TES);
  await page.goto(`/console/clientes/${A.id}`);
  const card = page.locator('[data-section="client-assets"]');
  const addressCard = page.locator('[data-section="client-deposit-addresses"]');
  await expect(card).toContainText('Activos habilitados');
  await expect(card.locator('[data-wallet-visibility="base-sepolia"]')).toHaveText('Billetera visible');
  await expect(addressCard.locator('[data-address-network="base-sepolia"]')).toBeVisible();
  const unusedRow = addressCard.locator(`[data-wallet="${unusedWallet.wallet_id}"]`);
  await expect(unusedRow).toContainText('Sin movimientos');
  await unusedRow.getByRole('button', { name: 'Eliminar' }).click();
  const deleteWallet = page.getByRole('dialog');
  await deleteWallet.getByLabel('Código 2FA para administrar la dirección').fill(await TES.otp.next());
  await deleteWallet.getByRole('button', { name: 'Eliminar permanentemente' }).click();
  await expect(unusedRow).toHaveCount(0);
  const retainedWallet = addressCard.locator(`[data-wallet="${oldWallet.wallet_id}"]`);
  await expect(retainedWallet).toBeVisible();
  await expect(retainedWallet.getByRole('button', { name: 'Eliminar' })).toBeDisabled();
  for (const id of ['USDC-ETH-SEPOLIA', 'USDC-BASE-SEPOLIA', 'USDC-ARB-SEPOLIA', 'USDC-AMOY', 'BNB-TESTNET']) {
    await expect(card.locator(`[data-asset="${id}"]`)).toContainText('Habilitado');
  }
  await expect(card).toContainText('Red no encendida'); // arb, amoy y bnb no están encendidas en esta instalación
  await card.getByLabel('Cambiar ETH-BASE-SEPOLIA').selectOption('exit_only');
  const dlg = page.getByRole('dialog');
  await expect(dlg).toContainText('un depósito nuevo quedará en revisión');
  await dlg.getByLabel('Código 2FA para cambiar el activo').fill(await TES.otp.next());
  await dlg.getByRole('button', { name: 'Aplicar' }).click();
  await expect(card.locator('[data-asset="ETH-BASE-SEPOLIA"]')).toContainText('Solo salida');
  await card.getByRole('button', { name: 'Editar activos de Base Sepolia' }).click();
  const group = page.getByRole('dialog');
  await expect(group).toContainText('Editar activos de Base Sepolia');
  await expect(group).toContainText('del grupo Base Sepolia');
  await group.getByLabel('Nuevo estado para los activos seleccionados').selectOption('exit_only');
  await group.getByLabel('Código 2FA para cambiar los activos seleccionados').fill(await TES.otp.next());
  await group.getByRole('button', { name: 'Aplicar a todos' }).click();
  await expect(card.locator('[data-asset="USDC-BASE-SEPOLIA"]')).toContainText('Solo salida');
  await expect(card.locator('[data-wallet-visibility="base-sepolia"]')).toHaveText('Billetera no visible');
  await expect(addressCard.locator('[data-address-network="base-sepolia"]')).toHaveCount(0);
  await card.getByLabel('Cambiar USDC-BASE-SEPOLIA').selectOption('enabled');
  const reopen = page.getByRole('dialog');
  await reopen.getByLabel('Código 2FA para cambiar el activo').fill(await TES.otp.next());
  await reopen.getByRole('button', { name: 'Aplicar' }).click();
  await expect(card.locator('[data-wallet-visibility="base-sepolia"]')).toHaveText('Billetera visible');
  await expect(addressCard.locator('[data-address-network="base-sepolia"]')).toBeVisible();
  for (const id of ['USDC-ARB-SEPOLIA', 'USDC-AMOY']) {
    await card.getByLabel(`Seleccionar activo ${id}`).check();
  }
  await card.getByRole('button', { name: 'Editar selección' }).click();
  const bulk = page.getByRole('dialog');
  await expect(bulk).toContainText('Cambiarán 2 de 2 activos');
  await bulk.getByLabel('Nuevo estado para los activos seleccionados').selectOption('exit_only');
  await bulk.getByLabel('Código 2FA para cambiar los activos seleccionados').fill(await TES.otp.next());
  await bulk.getByRole('button', { name: 'Aplicar a todos' }).click();
  await expect(card.locator('[data-asset="USDC-ARB-SEPOLIA"]')).toContainText('Solo salida');
  await expect(card.locator('[data-asset="USDC-AMOY"]')).toContainText('Solo salida');
  await shot(page, 'activos-cliente');
});

test('el Ejecutivo solicita y el Tesorero aprueba con 2FA', async ({ page, browser }) => {
  await consoleLogin(page, EJE);
  await page.goto(`/console/clientes/${A.id}`);
  const card = page.locator('[data-section="client-assets"]');
  await card.getByLabel('Cambiar USDC-BASE-SEPOLIA').selectOption('exit_only');
  const dlg = page.getByRole('dialog');
  await expect(dlg).toContainText('Solicitar cambio');
  await dlg.getByLabel('Motivo de la solicitud').fill('Cliente cierra operación en Base');
  await dlg.getByRole('button', { name: 'Enviar solicitud' }).click();
  await expect(card.locator('[data-asset="USDC-BASE-SEPOLIA"]')).toContainText('Solicitud pendiente');
  await expect(card.locator('[data-asset="USDC-BASE-SEPOLIA"]')).toContainText('Habilitado');

  const ctx = await browser.newContext(); const p2 = await ctx.newPage();
  await consoleLogin(p2, TES);
  await p2.goto('/console/aprobaciones');
  const req = p2.locator('[data-section="asset-requests"] [data-request]', { hasText: `Multired Alfa ${R}` });
  await expect(req).toContainText('USDC-BASE-SEPOLIA');
  await expect(req).toContainText('Base Sepolia');
  await expect(req).toContainText('Cliente cierra operación en Base');
  await req.getByLabel('Código 2FA para aprobar USDC-BASE-SEPOLIA').fill(await TES.otp.next());
  await req.getByRole('button', { name: 'Aprobar' }).click();
  await expect(req).toHaveCount(0);
  await p2.goto(`/console/clientes/${A.id}`);
  await expect(p2.locator('[data-asset="USDC-BASE-SEPOLIA"]')).toContainText('Solo salida');
  await ctx.close();
});

test('depósito en revisión: el Tesorero lo acredita con 2FA', async ({ page }) => {
  // Dirección del cliente en Base y un depósito que llegó en un activo en «Solo salida» (se simula en la base)
  await api('PUT', `/v1/clients/${A.id}/assets/USDC-BASE-SEPOLIA`, { status: 'enabled' });
  const w = await api('POST', `/v1/clients/${A.id}/deposit-address`, { network: 'base-sepolia' });
  const wid = sql(`SELECT id FROM wallets WHERE address = '${w.address.toLowerCase()}' AND network = 'base-sepolia'`);
  const tx = '0x' + randomBytes(32).toString('hex');
  sql(`INSERT INTO deposits (tx_hash, log_index, wallet_id, client_id, asset_id, from_address, amount, block_number, confirmations, status, source, network, held_reason)
       VALUES ('${tx}', 0, '${wid}', '${A.id}', 'ETH-BASE-SEPOLIA', '0x${'1'.repeat(40)}', 2500000000000000, 1, 1, 'held', 'webhook', 'base-sepolia', 'activo no habilitado para el cliente')`);
  await consoleLogin(page, TES);
  await page.goto('/console/aprobaciones');
  const row = page.locator(`[data-section="held-deposits"] [data-held]`, { hasText: `Multired Alfa ${R}` });
  await expect(row).toContainText('Base Sepolia');
  await expect(row).toContainText('0.0025');
  await shot(page, 'deposito-revision');
  await row.getByLabel(`Código 2FA para acreditar ${tx}`).fill(await TES.otp.next());
  await row.getByRole('button', { name: 'Acreditar' }).click();
  await expect(row).toHaveCount(0);
  expect(sql(`SELECT status || ' ' || released_by FROM deposits WHERE tx_hash = '${tx}'`)).toBe(`credited ${TES.email}`);
  await api('PUT', `/v1/clients/${A.id}/assets/USDC-BASE-SEPOLIA`, { status: 'exit_only' });
  await page.goto(`/console/clientes/${A.id}`);
  const addressCard = page.locator('[data-section="client-deposit-addresses"]');
  const walletId = baseWalletId;
  const usedWallet = addressCard.locator(`[data-wallet="${walletId}"]`);
  await expect(usedWallet).toContainText('Con movimientos');
  await usedWallet.getByRole('button', { name: 'Archivar' }).click();
  const archiveWallet = page.getByRole('dialog');
  await expect(archiveWallet).toContainText('seguirá monitoreándose');
  await archiveWallet.getByLabel('Código 2FA para administrar la dirección').fill(await TES.otp.next());
  await archiveWallet.getByRole('button', { name: 'Archivar' }).click();
  await expect(usedWallet).toHaveCount(0);
  await addressCard.getByRole('button', { name: 'Mostrar archivadas (1)' }).click();
  await expect(addressCard.locator(`[data-wallet-archived="${walletId}"]`)).toContainText('Archivada');
  expect(sql(`SELECT active::text || ' ' || (archived_at IS NOT NULL)::text FROM wallets WHERE id = '${walletId}'`)).toBe('true true');
});

test('portal: «Solo salida», dirección por red y lista blanca con red', async ({ page }) => {
  await portalLogin(page, adm);
  await expect(page.locator('[data-asset="ETH-BASE-SEPOLIA"]')).toContainText('Solo salida');
  await expect(page.locator('[data-asset="ETH-BASE-SEPOLIA"]')).toContainText('Base Sepolia');

  await page.getByRole('link', { name: 'Depósitos a Wallet' }).click();
  await expect(page.locator('[data-address]')).toHaveCount(0);
  await page.getByRole('button', { name: 'Generar nueva dirección' }).click();
  const dlg = page.getByRole('dialog');
  const sel = dlg.getByLabel('Red de la dirección');
  await expect(sel.locator('option')).toHaveCount(1);
  await expect(sel).not.toContainText('Base Sepolia');
  await sel.selectOption('eth-sepolia');
  await dlg.getByRole('button', { name: 'Generar' }).click();
  await expect(dlg).toHaveCount(0);
  const eth = page.locator('[data-address]', { has: page.getByTestId('address-network').filter({ hasText: 'Ethereum Sepolia' }) });
  await expect(eth).toHaveCount(1);
  await expect(page.locator('[data-address-network="base-sepolia"]')).toHaveCount(0);
  await expect(eth).toContainText('Recibe:');
  await shot(page, 'portal-depositos');

  await page.getByRole('link', { name: 'Lista blanca' }).click();
  await page.getByRole('button', { name: 'Agregar dirección' }).click();
  const d2 = page.getByRole('dialog');
  await d2.getByLabel('Red de la dirección').selectOption('base-sepolia');
  await d2.getByLabel(/^Dirección \(red Base Sepolia\)/).fill(DEST);
  await d2.getByRole('button', { name: 'Solicitar alta' }).click();
  await expect(page.locator(`[data-wl="${DEST}"]`).getByTestId('wl-network')).toHaveText('Base Sepolia');
  expect(sql(`SELECT network FROM wallets WHERE address = '${DEST}'`)).toBe('base-sepolia');
});
