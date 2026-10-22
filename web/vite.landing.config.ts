import path from 'node:path';
import { defineConfig, loadEnv } from 'vite';
import tailwindcss from '@tailwindcss/vite';
import { sinTecnicismos } from './vite-plugin-sin-tecnicismos';

// Build independiente de la página pública (Vercel): solo landing.html, en la raíz del dominio.
// VITE_APP_URL = URL de la aplicación (Railway) para los enlaces al portal y a la consola.
// VITE_API_URL = URL del API para el formulario «Solicitar acceso» (requiere LANDING_ORIGINS en el servidor).
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, import.meta.dirname, 'VITE_');
  const appUrl = (env.VITE_APP_URL ?? '').replace(/\/+$/, '');
  return {
    base: '/',
    plugins: [tailwindcss(), sinTecnicismos(), { name: 'landing-app-url', transformIndexHtml: (html: string) => html.replaceAll('__APP_URL__', appUrl) }],
    build: {
      outDir: 'dist-landing', emptyOutDir: true, sourcemap: false,
      rollupOptions: { input: path.resolve(import.meta.dirname, 'landing.html') },
    },
  };
});
