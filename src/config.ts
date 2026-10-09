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
  CONFIRMATIONS: z.coerce.number().int().min(1).default(3),
  WORKER_ENABLED: z.enum(['true', 'false']).default('true').transform((v) => v === 'true'),
  WORKER_INTERVAL_MS: z.coerce.number().int().min(1000).default(10_000),
  MIGRATE_ON_START: z.enum(['true', 'false']).default('true').transform((v) => v === 'true'),
});

export const config = Env.parse(process.env);
export const rpcUrl = config.RPC_URL ?? `https://${config.ALCHEMY_NETWORK}.g.alchemy.com/v2/${config.ALCHEMY_API_KEY}`;
