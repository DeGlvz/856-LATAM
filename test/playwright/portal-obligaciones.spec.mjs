// Portal fase 4 en el navegador: el acreedor registra con el código de contraparte, el deudor acepta o rechaza con motivo,
// carga CSV con reporte por fila, compensación (posición e historial con su asiento) y la consola con los estados nuevos.
// Funciona con ORIGIN_RULE=off o enforce (la consola no registra nada). Uso: BASE KEY DATABASE_URL … npx playwright test portal-obligaciones.spec.mjs
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test, expect } from '@playwright/test';
import { totp } from '../lib/totp.mjs';

const { KEY, SHOTS } = process.env;
const BASE = process.env.BASE ?? 'http://localhost:8080';
const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const R = Math.random().toString(36).slice(2, 8);
const IP = `10.79.${Math.floor(Math.random() * 250)}`;
const PW = 'clave-portal-obligaciones-1';
const USDC = 'USDC-ETH-SEPOLIA';
const TES = `pw-ob-tes-${R}@ejemplo.mx`;
let A, B, oprA, oprB, codeA, codeB, tesOtp;

test.describe.configure({ mode: 'serial' });
const shot = async (page, name) => { if (SHOTS) await page.screenshot({ path: `${SHOTS}/d-${name}.png`, fullPage: true }); };
const api = async (method, path, body, idem) => {
  const r = await fetch(BASE + path, { method, headers: { 'x-api-key': KEY, 'content-type': 'application/json', ...(idem ? { 'idempotency-key': `pwo-${idem}-${R}` } : {}) }, body: body && JSON.stringify(body) });
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
  const email = `pwo-${role}-${n}-${R}@ejemplo.mx`;
  const inv = inviter ? await inviter.s.call('POST', '/users/invites', { email, role }) : await api('POST', `/v1/clients/${client.id}/portal-invite`, { email });
  const s = session('/v1/portal', `${IP}.${n}`, 'x-856-portal');
  await s.call('POST', '/invites/accept', { token: inv.link.split('#')[1], name: `Usuario ${role} ${n}`, password: PW });
  await s.call('POST', '/auth/login', { email, password: PW });
  let otp = null;
  if (role === 'admin' || role === 'approver') { const st = await s.call('POST', '/auth/totp/setup', {}); otp = totp(st.secret); await s.call('POST', '/auth/totp/enable', { code: await otp.next() }); }
  return { email, s, otp, ip: `${IP}.${n}` };
}

test.beforeAll(async () => {
  const mk = async (name, idem) => { const c = await api('POST', '/v1/clients', { name: `${name} ${R}`, assets: [USDC] }, idem); await api('PATCH', `/v1/clients/${c.id}`, { status: 'active' }); return c; };
  A = await mk('Proveedora Alfa', 'a'); B = await mk('Compradora Beta', 'b');
  await api('POST', '/v1/entries', { kind: 'deposit', postings: [
    { account: `client:${B.id}:${USDC}:available`, direction: 'credit', amount: '500000000' },
    { account: `system:${USDC}:custody`, direction: 'debit', amount: '500000000' }] }, 'fb');
  const admA = await user(A, 'admin', 1); oprA = await user(A, 'operator', 2, admA);
  const admB = await user(B, 'admin', 3); oprB = await user(B, 'operator', 4, admB);
  codeA = (await oprA.s.call('GET', '/counterparty')).counterparty_code;
  codeB = (await oprB.s.call('GET', '/counterparty')).counterparty_code;
  execFileSync('node', ['dist/scripts/create-operator.js', TES, 'tesorero'], { cwd: ROOT, input: PW + '\n', env: process.env, stdio: ['pipe', 'pipe', 'ignore'] });
  const t = session('/v1', `${IP}.20`, 'x-856-console');
  await t.call('POST', '/auth/login', { email: TES, password: PW });
  const st = await t.call('POST', '/auth/totp/setup', {}); tesOtp = totp(st.secret);
  await t.call('POST', '/auth/totp/enable', { code: await tesOtp.next() });
});

async function portalLogin(page, u) {
  await page.context().setExtraHTTPHeaders({ 'x-forwarded-for': u.ip }); // IP propia: el límite de login es por IP
  await page.goto('/portal/login');
  await page.getByLabel('Correo').fill(u.email);
  await page.getByLabel('Contraseña').fill(PW);
  await page.getByRole('button', { name: 'Entrar' }).click();
  await expect(page.getByRole('button', { name: 'Salir' })).toBeVisible();
}

test('el acreedor registra con el código de contraparte confirmado', async ({ page }) => {
  await portalLogin(page, oprA);
  await expect(page.getByTestId('my-code')).toContainText(codeA); // Inicio muestra su código
  await page.getByRole('link', { name: 'Obligaciones' }).click();
  await page.getByRole('button', { name: 'Registrar obligación' }).click();
  const dlg = page.getByRole('dialog');
  await dlg.getByLabel('Código de contraparte del deudor').fill(codeB.toLowerCase());
  await dlg.getByRole('button', { name: 'Verificar' }).click();
  await expect(dlg.getByTestId('cp-name')).toContainText(`Compradora Beta ${R}`);
  await dlg.getByLabel('Activo').selectOption(USDC);
  await dlg.getByLabel(/Monto en/).fill('100.25');
  await dlg.getByLabel('Referencia (OC, factura, CFDI)').fill(`FAC-1-${R}`);
  await expect(dlg).toContainText('100.25');
  await shot(page, 'registrar');
  await dlg.getByRole('button', { name: 'Registrar' }).click();
  await page.getByRole('tab', { name: 'Por cobrar' }).click();
  const row = page.locator(`[data-ob="FAC-1-${R}"]`);
  await expect(row).toContainText('Por aceptar');
  await expect(row).toContainText(/vence en 7[12] h/);
  // Una segunda, para rechazarla
  await oprA.s.call('POST', '/obligations', { counterparty_code: codeB, asset_id: USDC, amount: '7000000', external_ref: `FAC-2-${R}` });
});

test('el deudor llega por el aviso, acepta una y rechaza otra con motivo', async ({ page, browser }) => {
  await portalLogin(page, oprB);
  await page.locator('[data-code="obligations_to_accept"]').getByRole('link', { name: 'Revisar obligaciones' }).click();
  await expect(page.getByRole('tab', { name: /Por aceptar/ })).toContainText('2');
  await page.locator(`[data-ob="FAC-1-${R}"]`).getByRole('button', { name: 'Aceptar' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Aceptar' }).click();
  await expect(page.locator(`[data-ob="FAC-1-${R}"]`)).toHaveCount(0);
  await page.locator(`[data-ob="FAC-2-${R}"]`).getByRole('button', { name: 'Rechazar' }).click();
  await page.getByLabel('Motivo').fill('No corresponde a ningún pedido');
  await page.getByRole('dialog').getByRole('button', { name: 'Rechazar' }).click();
  await expect(page.locator(`[data-ob="FAC-2-${R}"]`)).toHaveCount(0);
  await page.getByRole('tab', { name: 'Por pagar' }).click();
  await expect(page.locator(`[data-ob="FAC-1-${R}"]`)).toContainText('Aceptada');
  await shot(page, 'por-pagar');

  const ctx = await browser.newContext(); const p2 = await ctx.newPage();
  await portalLogin(p2, oprA);
  await p2.goto('/portal/obligaciones?tab=cobrar');
  await expect(p2.locator(`[data-ob="FAC-2-${R}"]`)).toContainText('Rechazada');
  await expect(p2.locator(`[data-ob="FAC-2-${R}"]`)).toContainText('No corresponde a ningún pedido');
  await ctx.close();
});

test('carga CSV: valida por fila y confirma solo las válidas', async ({ page }) => {
  await portalLogin(page, oprA);
  await page.goto('/portal/obligaciones');
  await page.getByRole('button', { name: 'Cargar CSV' }).click();
  const csv = `contraparte,activo,monto,referencia,vencimiento\n${codeB},${USDC},10,CSV-1-${R},2026-12-31\n${codeB},${USDC},2.5,CSV-2-${R},\n856-2222-2222,${USDC},1,CSV-3-${R},\n`;
  await page.getByLabel('Archivo CSV').setInputFiles({ name: 'facturas.csv', mimeType: 'text/csv', buffer: Buffer.from(csv) });
  await page.getByRole('button', { name: 'Validar' }).click();
  await expect(page.getByTestId('import-summary')).toContainText('3 filas · 2 válidas · 1 con error');
  await expect(page.getByRole('table', { name: 'Errores por fila' })).toContainText('Código de contraparte no encontrado');
  await shot(page, 'csv-validacion');
  await page.getByRole('button', { name: 'Confirmar 2' }).click();
  await expect(page.getByRole('dialog')).toContainText('Se registraron 2 obligación(es)');
  await page.getByRole('button', { name: 'Listo' }).click();
  await page.getByRole('tab', { name: 'Por cobrar' }).click();
  await expect(page.locator(`[data-ob="CSV-2-${R}"]`)).toContainText('Por aceptar');
});

test('compensación: posición propia y corrida con su asiento', async ({ page }) => {
  // B también registra una por cobrar a A, y A la acepta: hay ida y vuelta
  const ob = await oprB.s.call('POST', '/obligations', { counterparty_code: codeA, asset_id: USDC, amount: '40000000', external_ref: `NC-1-${R}` });
  await oprA.s.call('POST', `/obligations/${ob.id}/accept`, {});
  await portalLogin(page, oprA);
  await page.getByRole('link', { name: 'Compensación' }).click();
  const card = page.locator(`[data-position="${USDC}"]`);
  await expect(card).toContainText('100.25'); // por cobrar
  await expect(card).toContainText('40'); // por pagar
  await expect(card).toContainText('60.25'); // neto
  await shot(page, 'posicion');
  const opens = (await oprA.s.call('GET', `/obligations?status=open&asset_id=${USDC}`)).obligations.map((o) => o.id);
  const pv = await api('POST', '/v1/netting/preview', { asset_id: USDC, obligation_ids: opens });
  const run = await api('POST', '/v1/netting/runs', { asset_id: USDC, obligation_ids: opens, expected_net_amount: pv.net_amount }, 'run');
  expect(run.status).toBe('settled');
  await page.reload();
  await page.locator(`[data-run="${run.id}"]`).getByRole('button', { name: 'Ver detalle' }).click();
  await expect(page.getByTestId('run-entry')).toContainText('Abono');
  await expect(page.getByTestId('run-entry')).toContainText('60.25');
  await expect(page.getByRole('table', { name: 'Obligaciones de la corrida' }).locator('tbody tr')).toHaveCount(2);
  await shot(page, 'corrida');
});

test('consola: estados nuevos y la consola no registra con la regla de origen', async ({ page }) => {
  await page.context().setExtraHTTPHeaders({ 'x-forwarded-for': `${IP}.20` });
  await page.goto('/console/login');
  await page.getByLabel('Correo').fill(TES);
  await page.getByLabel('Contraseña').fill(PW);
  await page.getByRole('button', { name: 'Entrar' }).click();
  await page.getByLabel('Código de su app de autenticación').fill(await tesOtp.next());
  await page.getByRole('button', { name: 'Verificar' }).click();
  await expect(page.getByRole('button', { name: 'Salir' })).toBeVisible();
  await page.goto(`/console/compensacion?status=pending_acceptance&ref=CSV-1-${R}`);
  await expect(page.getByLabel('Estado')).toHaveValue('pending_acceptance');
  await expect(page.getByRole('row', { name: new RegExp(`CSV-1-${R}`) })).toContainText('Por aceptar');
  const enforce = (await (await page.request.get('/v1/summary')).json()).origin_rule === 'enforce';
  await expect(page.getByRole('button', { name: 'Nueva obligación' })).toHaveCount(enforce ? 0 : 1);
});
