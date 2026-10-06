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
});

export const config = Env.parse(process.env);
export const rpcUrl = `https://${config.ALCHEMY_NETWORK}.g.alchemy.com/v2/${config.ALCHEMY_API_KEY}`;
