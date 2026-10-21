import path from 'node:path';
import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// Enlaces de la landing hacia la aplicación: VITE_APP_URL (vacío = mismo origen)
const appLinks = (appUrl: string) => ({
  name: 'landing-app-url',
  transformIndexHtml: (html: string) => html.replaceAll('__APP_URL__', appUrl.replace(/\/+$/, '')),
});

// Servida por Fastify en /console. En desarrollo, /v1 se redirige al API local.
export default defineConfig(({ mode }) => ({
  base: '/console/',
  plugins: [react(), tailwindcss(), appLinks(loadEnv(mode, import.meta.dirname, 'VITE_').VITE_APP_URL ?? '')],
  resolve: { alias: { '@': path.resolve(import.meta.dirname, './src') } },
  server: { proxy: { '/v1': 'http://127.0.0.1:8080' } },
  // Tres entradas: consola de operación (/console), portal de clientes (/portal) y página pública (/); comparten el build
  build: {
    outDir: 'dist', emptyOutDir: true, sourcemap: false,
    rollupOptions: { input: { console: path.resolve(import.meta.dirname, 'index.html'), portal: path.resolve(import.meta.dirname, 'portal.html'), landing: path.resolve(import.meta.dirname, 'landing.html') } },
  },
    }));
