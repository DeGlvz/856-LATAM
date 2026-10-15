// Fase M1 en el navegador: distintivo fijo de ambiente («PRUEBAS» en el sandbox) en consola y portal,
// visible desde el login y en la cabecera al navegar. Requiere el API con ENVIRONMENT=sandbox.
// Uso: BASE BOOT_EMAIL BOOT_PASS … npx playwright test m1.spec.mjs
import { test, expect } from '@playwright/test';

const { BOOT_EMAIL, BOOT_PASS } = process.env;
const IP = `10.81.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`;

test('consola: «PRUEBAS» desde el login y en la cabecera', async ({ page }) => {
  await page.context().setExtraHTTPHeaders({ 'x-forwarded-for': IP });
  await page.goto('/console/login');
  await expect(page.getByTestId('env-banner')).toContainText('PRUEBAS');
  await page.getByLabel('Correo').fill(BOOT_EMAIL);
  await page.getByLabel('Contraseña').fill(BOOT_PASS);
  await page.getByRole('button', { name: 'Entrar' }).click();
  await expect(page.getByRole('button', { name: 'Salir' })).toBeVisible();
  await expect(page.getByTestId('env-badge')).toHaveText('PRUEBAS');
  await expect(page.getByTestId('env-banner')).toContainText('no son dinero real');
  await page.mouse.wheel(0, 2000);
  await expect(page.getByTestId('env-badge')).toBeVisible(); // la cabecera es fija
});

test('portal: «PRUEBAS» en el login del cliente', async ({ page }) => {
  await page.goto('/portal/login');
  await expect(page.getByTestId('env-banner')).toContainText('PRUEBAS');
});
