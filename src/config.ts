import 'dotenv/config';
import { z } from 'zod';

const Env = z.object({
  PORT: z.coerce.number().default(8080),
  HOST: z.string().default('0.0.0.0'),
  ALCHEMY_API_KEY: z.string().min(10),
  // Subdominio de red Alchemy: eth-mainnet, eth-sepolia, base-mainnet, polygon-mainnet, arb-mainnet…
  ALCHEMY_NETWORK: z.string().default('eth-sepolia'),
  API_KEYS: z.string().min(1).transform((s) => new Set(s.split(',').map((k) => k.trim()).filter(Boolean))),
  ALCHEMY_WEBHOOK_SIGNING_KEY: z.string().optional(),
  RATE_LIMIT_PER_MIN: z.coerce.number().default(120),
  DATABASE_URL: z.string().url(),
  DB_POOL_MAX: z.coerce.number().default(10),
  // Solo pruebas locales: sustituye la URL de Alchemy (p.ej. http://127.0.0.1:8545)
  RPC_URL: z.string().url().optional(),
  // Llave de PRUEBA (Sepolia) de la hot wallet. En producción se reemplaza por MPC (ver src/chain/signer.ts)
  SIGNER_PRIVATE_KEY: z.string().regex(/^0x[0-9a-fA-F]{64}$/, 'llave hex de 32 bytes con 0x').optional(),
  // Semilla HD (hex 32-64 bytes) para direcciones de depósito. Si falta, se deriva de SIGNER_PRIVATE_KEY (solo testnet)
  DEPOSIT_HD_SEED: z.string().regex(/^0x[0-9a-fA-F]{64,128}$/).optional(),
  // Alchemy Notify: registrar direcciones de depósito en el webhook Address Activity
  ALCHEMY_WEBHOOK_ID: z.string().optional(),
  ALCHEMY_NOTIFY_TOKEN: z.string().optional(),
  ALCHEMY_NOTIFY_URL: z.string().url().default('https://dashboard.alchemy.com/api/update-webhook-addresses'),
  // Barrido: ETH mínimo (wei) para barrer saldo nativo de una dirección de depósito
  SWEEP_MIN_NATIVE_WEI: z.coerce.bigint().default(1_000_000_000_000_000n), // 0.001 ETH
  SWEEP_ENABLED: z.enum(['true', 'false']).default('true').transform((v) => v === 'true'),
  CONFIRMATIONS: z.coerce.number().int().min(1).default(3),
  WORKER_ENABLED: z.enum(['true', 'false']).default('true').transform((v) => v === 'true'),
  WORKER_INTERVAL_MS: z.coerce.number().int().min(1000).default(10_000),
  MIGRATE_ON_START: z.enum(['true', 'false']).default('true').transform((v) => v === 'true'),
  // Consola de operación (/console): sesiones de operador con cookie httpOnly
  COOKIE_SECURE: z.enum(['true', 'false']).default('true').transform((v) => v === 'true'), // false solo en local (http)
  SESSION_TTL_MIN: z.coerce.number().int().min(5).default(480),   // vida máxima de la sesión
  SESSION_IDLE_MIN: z.coerce.number().int().min(1).default(30),   // cierre por inactividad
  LOGIN_MAX_FAILS: z.coerce.number().int().min(1).default(5),     // intentos antes de bloquear
  LOGIN_LOCK_MIN: z.coerce.number().int().min(1).default(15),
  // Primer operador (tesorero): se crea solo si la tabla está vacía. Borrar la contraseña después del primer arranque.
  CONSOLE_BOOTSTRAP_EMAIL: z.string().email().optional(),
  CONSOLE_BOOTSTRAP_PASSWORD: z.string().min(12).optional(),
  // Tablero: alerta de gas si la hot wallet tiene menos de este saldo nativo (wei)
  GAS_LOW_WEI: z.coerce.bigint().default(50_000_000_000_000_000n), // 0.05 ETH
});

export const config = Env.parse(process.env);
export const rpcUrl = config.RPC_URL ?? `https://${config.ALCHEMY_NETWORK}.g.alchemy.com/v2/${config.ALCHEMY_API_KEY}`;
