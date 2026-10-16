// Fase M1 — reglas de ambiente (production = dinero real / sandbox = pruebas de clientes).
// Se validan al arrancar; un error aquí detiene el proceso antes de abrir el puerto o tocar la cadena.
import { config, isProduction } from './config.js';
import { pool } from './db.js';
import { envOfNetwork, KNOWN, networkIds } from './chain/networks.js';

/** Red de la tesorería fiat (FIAT_CHAIN=base): Base mainnet en production, Base Sepolia en sandbox. */
export const fiatNetworkId = () => (isProduction ? `${config.FIAT_CHAIN}-mainnet` : `${config.FIAT_CHAIN}-sepolia`);

/** Errores de configuración (sin consultar la base). Devuelve la lista; vacía = válida. */
export function configErrors(): string[] {
  const errs: string[] = [];
  const env = config.ENVIRONMENT;
  for (const id of networkIds()) {
    const e = envOfNetwork(id);
    if (!e) {
      if (isProduction) errs.push(`Red desconocida en production: ${id} (solo se permiten redes main del registro)`);
    } else if (e !== env) {
      errs.push(`La red ${id} es de ${e === 'production' ? 'main' : 'prueba'} y este despliegue es ENVIRONMENT=${env}: no se mezclan redes de ambientes distintos`);
    }
  }
  for (const [k, v] of Object.entries(process.env)) {
    if (k.startsWith('SWEEP_MIN_') && k !== 'SWEEP_MIN_NATIVE_WEI' && v?.trim() && !/^\d+$/.test(v.trim())) {
      errs.push(`${k} debe ser un entero en unidades base del activo`);
    }
  }
  // Fase F1: fiat
  if (config.FIAT_MODE !== 'treasury') errs.push('FIAT_MODE=per_client está declarado pero no implementado: use treasury');
  if (!isProduction && config.FIAT_LIVE_ENABLED) errs.push('En sandbox el fiat solo usa el proveedor simulado: FIAT_LIVE_ENABLED debe ser false');
  if (isProduction && config.FIAT_LIVE_ENABLED) {
    if (!config.MONERIUM_CLIENT_ID || !config.MONERIUM_CLIENT_SECRET) errs.push('FIAT_LIVE_ENABLED=true exige MONERIUM_CLIENT_ID y MONERIUM_CLIENT_SECRET');
    if (config.MONERIUM_ENV !== 'production') errs.push('En production MONERIUM_ENV debe ser production');
    if (!networkIds().includes(fiatNetworkId())) errs.push(`FIAT_LIVE_ENABLED=true exige la red ${fiatNetworkId()} encendida (NETWORKS)`);
  }
  if (isProduction) {
    if (config.ORIGIN_RULE !== 'enforce') errs.push('En production ORIGIN_RULE=enforce es obligatorio (solo el cliente origina operaciones)');
    if (config.SIGNER_PRIVATE_KEY && !config.DEPOSIT_HD_SEED && !config.HD_MNEMONIC) {
      errs.push('En production la semilla de direcciones de depósito es propia: defina HD_MNEMONIC o DEPOSIT_HD_SEED (no se deriva de la llave de la hot wallet)');
    }
    if (config.DEPOSIT_HD_SEED && config.HD_MNEMONIC) errs.push('Defina HD_MNEMONIC o DEPOSIT_HD_SEED, no ambas');
    if (!config.TOTP_ENCRYPTION_KEY) errs.push('En production TOTP_ENCRYPTION_KEY es obligatoria (2FA del tesorero)');
  }
  return errs;
}

/** Redes del otro ambiente: sus activos se marcan inactivos para que no aparezcan ni operen aquí. */
export const foreignNetworks = () =>
  Object.keys(KNOWN).filter((id) => envOfNetwork(id) !== config.ENVIRONMENT);

// ── Modo de alta (solo production): sin tesorero con 2FA no se opera ──
export async function activeTreasurers(): Promise<number> {
  const { rows: [r] } = await pool.query(
    `SELECT count(*)::int AS n FROM operators WHERE role = 'tesorero' AND active AND totp_enabled_at IS NOT NULL`);
  return r.n as number;
}

let setup = false;
let checkedAt = 0;
/**
 * En production, mientras ningún tesorero activo tenga 2FA, el servicio queda en modo de alta:
 * worker apagado y /v1 responde 503 setup_required (salvo login y 2FA). Se levanta solo al activar el 2FA.
 */
export async function setupRequired(): Promise<boolean> {
  if (!isProduction) return false;
  if (!setup) return false;
  if (Date.now() - checkedAt > 5_000) {
    checkedAt = Date.now();
    if ((await activeTreasurers()) > 0) setup = false;
  }
  return setup;
}

/**
 * Arranque de production: exige al menos un tesorero activo con 2FA. Excepción única (primer despliegue):
 * si hay un tesorero sin 2FA o se va a crear con CONSOLE_BOOTSTRAP_*, arranca en modo de alta.
 */
export async function assertTreasuryAtBoot(log: { warn: (m: string) => void }) {
  if (!isProduction) return;
  if ((await activeTreasurers()) > 0) return;
  const { rows: [t] } = await pool.query(`SELECT count(*)::int AS n FROM operators WHERE role = 'tesorero' AND active`);
  const bootstrap = !!config.CONSOLE_BOOTSTRAP_EMAIL && !!config.CONSOLE_BOOTSTRAP_PASSWORD;
  if (t.n === 0 && !bootstrap) {
    throw new Error('production sin tesorero activo con 2FA: arranque rechazado (defina CONSOLE_BOOTSTRAP_* para el primer despliegue)');
  }
  setup = true; checkedAt = Date.now();
  log.warn('MODO DE ALTA: ningún tesorero activo tiene 2FA. Solo login y 2FA disponibles; el worker no corre hasta activarlo');
}

/** Rutas que siguen disponibles en modo de alta. */
export const SETUP_ALLOWED = [/^\/v1\/auth\//, /^\/v1\/meta$/];
