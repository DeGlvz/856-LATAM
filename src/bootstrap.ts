import { bootstrap } from './secrets.js';

// Importante: nada que lea la configuración se importa antes de cargar SSM (config.ts valida process.env al importarse).
bootstrap({ start: () => import('./server.js') }).catch((e) => {
  console.error('arranque abortado:', (e as Error).message);
  process.exit(1);
});
