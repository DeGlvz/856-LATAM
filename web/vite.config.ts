import path from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// Servida por Fastify en /console. En desarrollo, /v1 se redirige al API local.
export default defineConfig({
  base: '/console/',
  plugins: [react(), tailwindcss()],
  resolve: { alias: { '@': path.resolve(import.meta.dirname, './src') } },
  server: { proxy: { '/v1': 'http://127.0.0.1:8080' } },
  build: { outDir: 'dist', emptyOutDir: true, sourcemap: false },
});
