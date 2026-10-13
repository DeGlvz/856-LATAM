// Recorridos reales del portal de clientes (fase 1) en el navegador:
// invitación del primer admin desde la consola → alta → 2FA obligatorio → llaves (Ed25519 generada en el navegador y token de lectura)
// → invitación de un operador → login con 2FA. La llave descargada se descifra con la frase y firma una petición real.
import { createDecipheriv, createHash, createPrivateKey, pbkdf2Sync, randomBytes, sign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test, expect } from '@playwright/test';
import { totp } from '../lib/totp.mjs';

const { KEY, BOOT_EMAIL, BOOT_PASS } = process.env;
const BASE = process.env.BASE ?? 'http://localhost:8080';
const R = Math.random().toString(36).slice(2, 8);
const ADMIN = `pw-admin-${R}@ejemplo.mx`, OPER = `pw-oper-${R}@ejemplo.mx`, PW = 'clave-portal-playwright-1', PASS = 'frase-de-la-llave-123';
const LINK_RE = /https?:\/\/[^\s]+\/portal\/invitacion#[A-Za-z0-9_-]+/;
let client, otp, adminLink;

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  const r = await fetch(`${BASE}/v1/clients`, { method: 'POST', headers: { 'x-api-key': KEY, 'content-type': 'application/json', 'idempotency-key': `pw-portal-${R}` },
    body: JSON.stringify({ name: `PW Portal ${R}`, assets: ['ETH-SEPOLIA'] }) });
  client = await r.json();
  expect(client.id).toBeTruthy();
});

async function portalLogin(page, email, code) {
  await page.goto('/portal/login');
  await page.getByLabel('Correo').fill(email);
  await page.getByLabel('Contraseña').fill(PW);
  await page.getByRole('button', { name: 'Entrar' }).click();
  if (code) {
    await page.getByLabel('Código de su app de autenticación').fill(await code());
    await page.getByRole('button', { name: 'Verificar' }).click();
  }
  await expect(page.getByRole('button', { name: 'Salir' })).toBeVisible();
}
async function acceptInvite(page, link, name) {
  await page.goto(link);
  await expect(page).toHaveURL(/\/portal\/invitacion$/); // el token sale de la barra de direcciones
  await page.getByLabel('Nombre completo').fill(name);
  await page.getByLabel('Contraseña', { exact: true }).fill(PW);
  await page.getByLabel('Confirmar contraseña').fill(PW);
  await page.getByRole('button', { name: 'Crear mi acceso' }).click();
  await expect(page.getByText('Su usuario quedó activo.')).toBeVisible();
}

test('consola: 856 invita al primer admin y el enlace se muestra una vez', async ({ page }) => {
  await page.goto('/console/login');
  await page.getByLabel('Correo').fill(BOOT_EMAIL);
  await page.getByLabel('Contraseña').fill(BOOT_PASS);
  await page.getByRole('button', { name: 'Entrar' }).click();
  await expect(page.getByRole('button', { name: 'Salir' })).toBeVisible();
  await page.goto(`/console/clientes/${client.id}`);
  await expect(page.getByText('Portal del cliente')).toBeVisible();
  await page.getByRole('button', { name: 'Invitar primer admin' }).click();
  await page.getByLabel('Correo del administrador').fill(ADMIN);
  await page.getByRole('button', { name: 'Generar enlace' }).click();
  adminLink = (await page.getByTestId('portal-invite-link').textContent()).trim();
  expect(adminLink).toMatch(LINK_RE);
  await page.getByRole('button', { name: 'Listo' }).click();
  await expect(page.getByRole('button', { name: 'Invitar primer admin' })).toBeVisible(); // aún sin admin: puede reenviar
});

test('admin acepta la invitación y el portal le exige 2FA antes de todo', async ({ page }) => {
  await acceptInvite(page, adminLink, 'Ana Admin Playwright');
  await portalLogin(page, ADMIN);
  await expect(page).toHaveURL(/\/portal\/seguridad$/);
  await expect(page.getByText('Su rol exige verificación en dos pasos')).toBeVisible();
  await page.goto('/portal/llaves');
  await expect(page).toHaveURL(/\/portal\/seguridad$/); // no puede saltarse la activación

  await page.getByRole('button', { name: 'Activar 2FA' }).click();
  await expect(page.getByAltText('Código QR para la app de autenticación')).toBeVisible();
  const secret = (await page.locator('.font-mono.break-all').first().textContent()).replace(/\s/g, '');
  otp = totp(secret);
  await page.getByLabel('Código para activar 2FA').fill(await otp.next());
  await page.getByRole('button', { name: 'Confirmar y activar' }).click();
  await expect(page.getByText('Guarde estos códigos de recuperación ahora')).toBeVisible();
  await expect(page.locator('ol li')).toHaveCount(10);
  await expect(page.getByText('Activa', { exact: true })).toBeVisible();
});

test('llave Ed25519: se genera en el navegador, se descarga cifrada y firma peticiones', async ({ page }) => {
  await portalLogin(page, ADMIN, otp.next);
  await page.goto('/portal/llaves');
  await page.getByRole('button', { name: 'Nueva llave' }).click();
  await page.getByLabel('Nombre').fill('ERP Playwright');
  await page.getByLabel('Frase para cifrar la llave privada').fill(PASS);
  await page.getByLabel('Confirmar frase').fill(PASS);
  await page.getByLabel('Código 2FA para la llave').fill(await otp.next());
  const dl = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Generar y descargar' }).click();
  const file = await (await dl).path();
  await expect(page.getByText(/Llave 856k_[0-9a-f]+ creada/)).toBeVisible();

  // Descifrar como lo haría el servidor del cliente y firmar GET /v1/portal/ping
  const j = JSON.parse(readFileSync(file, 'utf8'));
  expect(j.format).toBe('856-latam/ed25519-key/v1');
  const b = (s) => Buffer.from(s, 'base64url');
  const aes = pbkdf2Sync(PASS, b(j.kdf.salt), j.kdf.iterations, 32, 'sha256');
  const ct = b(j.cipher.ct);
  const d = createDecipheriv('aes-256-gcm', aes, b(j.cipher.iv));
  d.setAAD(Buffer.from(j.prefix)); d.setAuthTag(ct.subarray(-16));
  const pk = createPrivateKey({ key: Buffer.concat([d.update(ct.subarray(0, -16)), d.final()]), format: 'der', type: 'pkcs8' });
  const ts = String(Math.floor(Date.now() / 1000)), nonce = randomBytes(16).toString('hex');
  const msg = ['GET', '/v1/portal/ping', ts, nonce, createHash('sha256').update('').digest('hex')].join('\n');
  const r = await fetch(`${BASE}/v1/portal/ping`, { headers: { 'x-856-key': j.prefix, 'x-856-timestamp': ts, 'x-856-nonce': nonce,
    'x-856-signature': sign(null, Buffer.from(msg), pk).toString('base64url') } });
  expect(r.status).toBe(200);
  expect((await r.json()).client_id).toBe(client.id);

  await page.reload();
  await expect(page.getByRole('cell', { name: /ERP Playwright/ })).toBeVisible();
  await expect(page.getByText('Firma Ed25519').first()).toBeVisible();
});

test('token de lectura: se muestra una vez y solo sirve para consultar', async ({ page }) => {
  await portalLogin(page, ADMIN, otp.next);
  await page.goto('/portal/llaves');
  await page.getByRole('button', { name: 'Nueva llave' }).click();
  await page.getByLabel('Nombre').fill('BI Playwright');
  await page.getByRole('radio', { name: /Token de solo lectura/ }).click();
  await page.getByLabel('Código 2FA para la llave').fill(await otp.next());
  await page.getByRole('button', { name: 'Generar token' }).click();
  await expect(page.getByText('Copie el token ahora')).toBeVisible();
  const token = (await page.locator('.font-mono.break-all').first().textContent()).match(/856r_[0-9a-f]+_[A-Za-z0-9_-]+_[0-9a-f]{4}/)[0];
  const ok = await fetch(`${BASE}/v1/portal/me`, { headers: { authorization: `Bearer ${token}` } });
  expect(ok.status).toBe(200);
  const post = await fetch(`${BASE}/v1/portal/keys/challenge`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: '{}' });
  expect(post.status).toBeGreaterThanOrEqual(400);
});

test('admin invita a un operador; el operador entra sin 2FA y no ve administración', async ({ page, browser }) => {
  await portalLogin(page, ADMIN, otp.next);
  await page.goto('/portal/usuarios');
  await page.getByRole('button', { name: /Invitar/ }).first().click();
  await page.getByLabel('Correo', { exact: true }).fill(OPER);
  await page.getByLabel('Rol', { exact: true }).selectOption('operator');
  await page.getByRole('button', { name: 'Generar enlace' }).click();
  const link = (await page.getByText(LINK_RE).textContent()).match(LINK_RE)[0];
  await page.getByRole('button', { name: 'Listo' }).click();
  await expect(page.getByText(OPER)).toBeVisible(); // invitación pendiente

  const ctx = await browser.newContext();
  const p2 = await ctx.newPage();
  await acceptInvite(p2, link, 'Óscar Operador');
  await portalLogin(p2, OPER);
  await expect(p2).toHaveURL(/\/portal\/?$/);
  await expect(p2.getByRole('heading', { name: /Bienvenido, Óscar/ })).toBeVisible();
  await p2.goto('/portal/usuarios');
  await expect(p2).not.toHaveURL(/\/portal\/usuarios$/);
  await ctx.close();
});

test('aislamiento: la sesión del portal no abre la consola', async ({ page }) => {
  await portalLogin(page, ADMIN, otp.next);
  const r = await page.request.get('/v1/clients', { headers: { 'x-856-console': '1' } });
  expect(r.status()).toBe(401);
});
