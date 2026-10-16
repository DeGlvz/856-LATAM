// Registro de gas en el navegador: el tablero avisa de gas sin registrar; el tesorero registra el fondeo con 2FA
// y lo ve en «Retiros y depósitos → Fondeos de gas». Uso: BASE KEY RPC_URL FUNDER_PK … npx playwright test gas.spec.mjs
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test, expect } from '@playwright/test';
import { createPublicClient, createWalletClient, http, parseEther } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { hardhat } from 'viem/chains';
import { totp } from '../lib/totp.mjs';

const { KEY, SHOTS, RPC_URL, FUNDER_PK } = process.env;
const BASE = process.env.BASE ?? 'http://localhost:8080';
const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const R = Math.random().toString(36).slice(2, 8);
const IP = `10.77.${Math.floor(Math.random() * 250)}`;
const PW = 'clave-tesorero-gas-123';
const TES = `pw-gas-${R}@ejemplo.mx`;
let otp, hash;

test.describe.configure({ mode: 'serial' });
const shot = async (page, name) => { if (SHOTS) await page.screenshot({ path: `${SHOTS}/gas-${name}.png`, fullPage: true }); };

test.beforeAll(async () => {
  execFileSync('node', ['dist/scripts/create-operator.js', TES, 'tesorero'], { cwd: ROOT, input: PW + '\n', env: process.env, stdio: ['pipe', 'pipe', 'ignore'] });
  let cookie = null;
  const call = async (method, path, body) => {
    const r = await fetch(BASE + path, { method, headers: { 'x-forwarded-for': `${IP}.1`, 'content-type': 'application/json', ...(cookie ? { cookie } : {}), ...(method !== 'GET' ? { 'x-856-console': '1' } : {}) }, body: body && JSON.stringify(body) });
    const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
    return r.json().catch(() => null);
  };
  await call('POST', '/v1/auth/login', { email: TES, password: PW });
  const st = await call('POST', '/v1/auth/totp/setup', {}); otp = totp(st.secret);
  await call('POST', '/v1/auth/totp/enable', { code: await otp.next() });
  // Fondeo real de la hot wallet desde fuera de la plataforma
  const hot = (await (await fetch(`${BASE}/v1/treasury/hot-wallet`, { headers: { 'x-api-key': KEY } })).json()).address;
  const pub = createPublicClient({ chain: hardhat, transport: http(RPC_URL) });
  const w = createWalletClient({ account: privateKeyToAccount(FUNDER_PK), chain: hardhat, transport: http(RPC_URL) });
  hash = await w.sendTransaction({ to: hot, value: parseEther('0.75') });
  await pub.waitForTransactionReceipt({ hash });
  for (let i = 0; i < 5; i++) await pub.request({ method: 'evm_mine', params: [] });
});

test('el tablero avisa del gas sin registrar y el tesorero lo registra con 2FA', async ({ page }) => {
  await page.context().setExtraHTTPHeaders({ 'x-forwarded-for': `${IP}.2` });
  await page.goto('/console/login');
  await page.getByLabel('Correo').fill(TES);
  await page.getByLabel('Contraseña').fill(PW);
  await page.getByRole('button', { name: 'Entrar' }).click();
  await page.getByLabel('Código de su app de autenticación').fill(await otp.next());
  await page.getByRole('button', { name: 'Verificar' }).click();
  await expect(page.getByRole('button', { name: 'Salir' })).toBeVisible();
  const alert = page.locator('[data-section="gas-ledger"]');
  await expect(alert).toContainText('Gas sin registrar en el libro');
  await shot(page, 'alerta');
  await alert.getByRole('button', { name: 'Registrar fondeo de gas' }).first().click();
  const dlg = page.getByRole('dialog');
  await dlg.getByLabel('Red del fondeo').selectOption('eth-sepolia');
  await dlg.getByLabel('Hash de la transacción').fill(hash);
  await dlg.getByLabel('Código 2FA para confirmar').fill(await otp.next());
  await dlg.getByRole('button', { name: 'Registrar' }).click();
  await expect(dlg.getByTestId('gas-registered')).toContainText('0.75');
  await shot(page, 'registrado');
  await dlg.getByRole('button', { name: 'Listo' }).click();
  await page.getByRole('link', { name: 'Retiros y depósitos' }).click();
  await page.getByRole('tab', { name: 'Fondeos de gas' }).click();
  await expect(page.locator(`[data-gas-funding="${hash.toLowerCase()}"]`)).toContainText('0.75');
  await shot(page, 'lista');
});
