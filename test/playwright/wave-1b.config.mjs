import { defineConfig, devices } from '@playwright/test';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  testDir: '.',
  testMatch: 'wave-1b.spec.mjs',
  workers: 1,
  timeout: 30_000,
  reporter: 'list',
  outputDir: fileURLToPath(new URL('./test-results/wave-1b/', import.meta.url)),
  use: { ...devices['Desktop Chrome'], baseURL: 'http://127.0.0.1:4173', locale: 'es-MX' },
  webServer: {
    command: 'node node_modules/vite/bin/vite.js preview --host 127.0.0.1 --port 4173 --strictPort',
    cwd: fileURLToPath(new URL('../../web/', import.meta.url)),
    url: 'http://127.0.0.1:4173',
    reuseExistingServer: false,
  },
});
