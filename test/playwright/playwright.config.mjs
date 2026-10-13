// Pruebas de navegador de la consola (fase 5). Corren contra un API ya levantado:
//   BASE=http://localhost:8080 KEY=… DATABASE_URL=… BOOT_EMAIL=… BOOT_PASS=… npx playwright test
// El API debe tener COOKIE_SECURE=false, DUAL_APPROVAL=console, APPROVAL_REQUIRE_2FA=true y TOTP_ENCRYPTION_KEY.
import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: '.',
  testMatch: /.*\.spec\.mjs/,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 240_000, // el servidor no acepta un código TOTP dos veces: algunas pruebas esperan al siguiente (≤ 30 s)
  reporter: [['list']],
  use: {
    baseURL: process.env.BASE ?? 'http://localhost:8080',
    locale: 'es-MX',
    timezoneId: 'America/Mexico_City',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    ...devices['Desktop Chrome'],
    viewport: { width: 1366, height: 860 },
  },
});
