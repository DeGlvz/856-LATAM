// Fase F1 en el navegador: el cliente ve los datos SEPA y crea un aviso de pago; el depósito aparece «Recibido,
// pendiente de liberación»; el tesorero lo libera con 2FA en la consola y el cliente lo ve acreditado.
// Proveedor SIMULADO (sandbox). Uso: BASE KEY DATABASE_URL RPC_B FUNDER_PK EURE … npx playwright test fiat.spec.mjs
//   API con NETWORKS=eth-sepolia,base-sepolia (Base Sepolia = cadena local B) y FIAT_LIVE_ENABLED=false.
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { test, expect } from '@playwright/test';
import { createPublicClient, createWalletClient, erc20Abi, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { totp } from '../lib/totp.mjs';

const { KEY, SHOTS, DATABASE_URL, RPC_B, FUNDER_PK, EURE } = process.env;
const BASE = process.env.BASE ?? 'http://localhost:8080';
const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const R = Math.random().toString(36).slice(2, 8);
const IP = `10.78.${Math.floor(Math.random() * 250)}`;
const PW = 'clave-portal-fiat-1234';
const TES = `pw-fiat-tes-${R}@ejemplo.mx`;
let A, oprA, tes, tesOtp, ASSET, treasury, reference;

test.describe.configure({ mode: 'serial' });
const shot = async (page, name) => { if (SHOTS) await page.screenshot({ path: `${SHOTS}/f1-${name}.png`, fullPage: true }); };
const api = async (method, path, body, idem) => {
  const r = await fetch(BASE + path, { method, headers: { 'x-api-key': KEY, 'content-type': 'application/json', ...(idem ? { 'idempotency-key': `pwf-${idem}-${R}` } : {}) }, body: body && JSON.stringify(body) });
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
async function user(client, role, n, inviter) {
  const email = `pwf-${role}-${n}-${R}@ejemplo.mx`;
  const inv = inviter ? await inviter.s.call('POST', '/users/invites', { email, role }) : await api('POST', `/v1/clients/${client.id}/portal-invite`, { email });
  const s = session('/v1/portal', `${IP}.${n}`, 'x-856-portal');
  await s.call('POST', '/invites/accept', { token: inv.link.split('#')[1], name: `Usuario ${role} ${n}`, password: PW });
  await s.call('POST', '/auth/login', { email, password: PW });
  let otp = null;
  if (role === 'admin') { const st = await s.call('POST', '/auth/totp/setup', {}); otp = totp(st.secret); await s.call('POST', '/auth/totp/enable', { code: await otp.next() }); }
  return { email, s, otp, ip: `${IP}.${n}` };
}
async function portalLogin(page, u) {
  await page.context().setExtraHTTPHeaders({ 'x-forwarded-for': u.ip });
  await page.goto('/portal/login');
  await page.getByLabel('Correo').fill(u.email);
  await page.getByLabel('Contraseña').fill(PW);
  await page.getByRole('button', { name: 'Entrar' }).click();
  await expect(page.getByRole('button', { name: 'Salir' })).toBeVisible();
}

test.beforeAll(async () => {
  // Activo EURe de prueba en Base Sepolia (uno solo vigente) y tesorero con 2FA
  const db = new pg.Pool({ connectionString: DATABASE_URL });
  const cur = (await db.query(`SELECT id FROM assets WHERE network = 'base-sepolia' AND symbol = 'EURe' AND active AND contract_address = lower($1)`, [EURE])).rows[0];
  ASSET = cur?.id ?? `EURE-PW${R.toUpperCase()}`;
  if (!cur) {
    await api('POST', '/v1/assets', { id: ASSET, symbol: 'EURe', chain: 'ethereum', network: 'base-sepolia', kind: 'erc20', contract_address: EURE, decimals: 18 });
    await db.query(`UPDATE assets SET active = false WHERE symbol = 'EURe' AND network = 'base-sepolia' AND id <> $1`, [ASSET]);
  }
  await db.end();
  execFileSync('node', ['dist/scripts/create-operator.js', TES, 'tesorero'], { cwd: ROOT, input: PW + '\n', env: process.env, stdio: ['pipe', 'pipe', 'ignore'] });
  tes = session('/v1', `${IP}.20`, 'x-856-console');
  await tes.call('POST', '/auth/login', { email: TES, password: PW });
  const st = await tes.call('POST', '/auth/totp/setup', {}); tesOtp = totp(st.secret);
  await tes.call('POST', '/auth/totp/enable', { code: await tesOtp.next() });
  const s = await tes.call('POST', '/console/fiat/setup', { code: await tesOtp.next() });
  treasury = s.account.address;
  A = await api('POST', '/v1/clients', { name: `Euros Alfa ${R}`, assets: [ASSET] }, 'a');
  await api('PATCH', `/v1/clients/${A.id}`, { status: 'active' });
  const admA = await user(A, 'admin', 1); oprA = await user(A, 'operator', 2, admA);
});

test('el cliente ve los datos SEPA y crea un aviso de pago', async ({ page }) => {
  await portalLogin(page, oprA);
  await page.getByRole('link', { name: 'Recibir euros' }).click();
  const card = page.getByTestId('fiat-instructions');
  await expect(card).toContainText('ZZ00 SIMU'); // IBAN del proveedor simulado, en grupos de 4
  await expect(card).toContainText(ASSET);
  await shot(page, 'recibir');
  await page.getByRole('link', { name: 'Avisos de pago' }).click();
  await page.getByRole('button', { name: 'Nuevo aviso' }).click();
  const dlg = page.getByRole('dialog');
  await dlg.getByLabel('Monto (EUR)').fill('1,250.50');
  await expect(dlg.getByRole('button', { name: 'Crear aviso' })).toBeDisabled(); // sin separador de miles
  await dlg.getByLabel('Monto (EUR)').fill('1250.50');
  await dlg.getByLabel('Nota (opcional)').fill(`Factura ${R}`);
  await dlg.getByRole('button', { name: 'Crear aviso' }).click();
  reference = (await page.getByTestId('intent-reference').textContent()).trim();
  expect(reference).toMatch(/^856-[A-Z0-9]{4}-[A-Z0-9]{4}-\d{3}$/);
  await expect(page.getByRole('dialog')).toContainText('1,250.50 €');
  await shot(page, 'aviso-creado');
  await page.getByRole('button', { name: 'Listo' }).click();
  const row = page.locator(`[data-intent="${reference}"]`);
  await expect(row).toContainText('Abierto');
  await expect(row).toContainText('1,250.50 €');
});

test('el depósito llega y se concilia: «Recibido, pendiente de liberación»', async ({ page }) => {
  const chain = { id: 31338, name: 'B', nativeCurrency: { name: 'E', symbol: 'E', decimals: 18 }, rpcUrls: { default: { http: [RPC_B] } } };
  const w = createWalletClient({ account: privateKeyToAccount(FUNDER_PK), chain, transport: http() });
  const h = await w.writeContract({ address: EURE, abi: erc20Abi, functionName: 'transfer', args: [treasury, 125050n * 10n ** 16n] });
  await createPublicClient({ chain, transport: http() }).waitForTransactionReceipt({ hash: h });
  await tes.call('POST', '/console/fiat/simulate', { amount: '1250.50', memo: reference, payer_name: 'Euros Alfa SA', tx_hash: h });
  await tes.call('POST', '/console/fiat/poll', {});
  await portalLogin(page, oprA);
  await page.getByRole('link', { name: 'Recibir euros' }).click();
  await expect(page.getByTestId('fiat-dep-status').first()).toHaveText('Recibido, pendiente de liberación');
  await shot(page, 'pendiente');
});

test('el tesorero libera con 2FA en la consola y el cliente lo ve acreditado', async ({ page }) => {
  await page.context().setExtraHTTPHeaders({ 'x-forwarded-for': `${IP}.21` });
  await page.goto('/console/login');
  await page.getByLabel('Correo').fill(TES);
  await page.getByLabel('Contraseña').fill(PW);
  await page.getByRole('button', { name: 'Entrar' }).click();
  await page.getByLabel('Código de su app de autenticación').fill(await tesOtp.next());
  await page.getByRole('button', { name: 'Verificar' }).click();
  await expect(page.getByRole('button', { name: 'Salir' })).toBeVisible();
  await page.getByRole('link', { name: 'Depósitos en euros' }).click();
  await expect(page.getByTestId('fiat-status')).toContainText('Proveedor simulado');
  await expect(page.getByTestId('fiat-status')).toContainText('Activa');
  const row = page.locator('tr', { hasText: reference }).first();
  await expect(row).toContainText('Conciliada');
  await expect(row).toContainText(`Euros Alfa ${R}`);
  await shot(page, 'consola-bandeja');
  await row.getByRole('button', { name: 'Liberar' }).click();
  const dlg = page.getByRole('dialog');
  await expect(dlg).toContainText('1,250.50 €');
  await dlg.getByLabel('Código 2FA para confirmar').fill(await tesOtp.next());
  await dlg.getByRole('button', { name: 'Liberar' }).click();
  await expect(page.locator('tr', { hasText: reference }).first()).toContainText('Liberada');
  await shot(page, 'consola-liberada');
  await portalLogin(page, oprA);
  await page.getByRole('link', { name: 'Recibir euros' }).click();
  await expect(page.getByTestId('fiat-dep-status').first()).toHaveText('Acreditado');
  await page.getByRole('link', { name: 'Avisos de pago' }).click();
  await expect(page.locator(`[data-intent="${reference}"]`)).toContainText('Recibido');
});
