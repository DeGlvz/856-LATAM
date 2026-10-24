// Multi-red EVM (ola 1). Un registro de redes encendidas: cada una con su cliente RPC, chainId, confirmaciones,
// umbral de gas, tope de comisión, webhook de Alchemy y explorador. La misma llave de Alchemy sirve para todas.
//
// NETWORKS=eth-sepolia,base-sepolia,…  (si no se define: solo ALCHEMY_NETWORK, como antes)
// Ajustes por red (sufijo = slug en mayúsculas con guion bajo, p. ej. BASE_SEPOLIA):
//   RPC_URL_<RED>                       solo para pruebas locales (por defecto, la URL de Alchemy)
//   CONFIRMATIONS_<RED>                 por defecto CONFIRMATIONS
//   GAS_LOW_WEI_<RED>                   por defecto GAS_LOW_WEI
//   GAS_BUMP_MAX_FEE_WEI_<RED>          por defecto GAS_BUMP_MAX_FEE_WEI
//   ALCHEMY_WEBHOOK_ID_<RED>            webhook Address Activity de esa red
//   ALCHEMY_WEBHOOK_SIGNING_KEY_<RED>   su llave de firma (para la red principal se aceptan las variables sin sufijo)
import { createPublicClient, http, type PublicClient } from 'viem';
import { recordUsage } from '../usage.js';
import { config } from '../config.js';
import { HttpError } from '../idempotency.js';

interface Known { chainId: number; explorer: string; native: string; label: string; env: 'test' | 'main' }
/**
 * Redes conocidas (los chainId se verifican al arrancar contra la propia red).
 * env: 'test' solo puede encenderse con ENVIRONMENT=sandbox; 'main' solo con ENVIRONMENT=production (fase M1).
 */
export const KNOWN: Record<string, Known> = {
  'eth-sepolia': { chainId: 11155111, explorer: 'https://sepolia.etherscan.io', native: 'ETH', label: 'Ethereum Sepolia', env: 'test' },
  'base-sepolia': { chainId: 84532, explorer: 'https://sepolia.basescan.org', native: 'ETH', label: 'Base Sepolia', env: 'test' },
  'arb-sepolia': { chainId: 421614, explorer: 'https://sepolia.arbiscan.io', native: 'ETH', label: 'Arbitrum Sepolia', env: 'test' },
  'polygon-amoy': { chainId: 80002, explorer: 'https://amoy.polygonscan.com', native: 'POL', label: 'Polygon Amoy', env: 'test' },
  'bnb-testnet': { chainId: 97, explorer: 'https://testnet.bscscan.com', native: 'BNB', label: 'BNB Smart Chain Testnet', env: 'test' },
  'opt-sepolia': { chainId: 11155420, explorer: 'https://sepolia-optimism.etherscan.io', native: 'ETH', label: 'OP Sepolia', env: 'test' },
  'avax-fuji': { chainId: 43113, explorer: 'https://testnet.snowtrace.io', native: 'AVAX', label: 'Avalanche Fuji', env: 'test' },
  'linea-sepolia': { chainId: 59141, explorer: 'https://sepolia.lineascan.build', native: 'ETH', label: 'Linea Sepolia', env: 'test' },
  'celo-sepolia': { chainId: 11142220, explorer: 'https://celo-sepolia.blockscout.com', native: 'CELO', label: 'Celo Sepolia', env: 'test' },
  'unichain-sepolia': { chainId: 1301, explorer: 'https://sepolia.uniscan.xyz', native: 'ETH', label: 'Unichain Sepolia', env: 'test' },
  'worldchain-sepolia': { chainId: 4801, explorer: 'https://worldchain-sepolia.explorer.alchemy.com', native: 'ETH', label: 'World Chain Sepolia', env: 'test' },
  // Fase M1 — redes principales (dinero real)
  'eth-mainnet': { chainId: 1, explorer: 'https://etherscan.io', native: 'ETH', label: 'Ethereum', env: 'main' },
  'base-mainnet': { chainId: 8453, explorer: 'https://basescan.org', native: 'ETH', label: 'Base', env: 'main' },
  'arb-mainnet': { chainId: 42161, explorer: 'https://arbiscan.io', native: 'ETH', label: 'Arbitrum One', env: 'main' },
  'bnb-mainnet': { chainId: 56, explorer: 'https://bscscan.com', native: 'BNB', label: 'BNB Smart Chain', env: 'main' },
  'opt-mainnet': { chainId: 10, explorer: 'https://optimistic.etherscan.io', native: 'ETH', label: 'OP Mainnet', env: 'main' },
  'polygon-mainnet': { chainId: 137, explorer: 'https://polygonscan.com', native: 'POL', label: 'Polygon PoS', env: 'main' },
  'avax-mainnet': { chainId: 43114, explorer: 'https://snowtrace.io', native: 'AVAX', label: 'Avalanche C-Chain', env: 'main' },
  'linea-mainnet': { chainId: 59144, explorer: 'https://lineascan.build', native: 'ETH', label: 'Linea', env: 'main' },
  'celo-mainnet': { chainId: 42220, explorer: 'https://celoscan.io', native: 'CELO', label: 'Celo', env: 'main' },
  'unichain-mainnet': { chainId: 130, explorer: 'https://uniscan.xyz', native: 'ETH', label: 'Unichain', env: 'main' },
  'worldchain-mainnet': { chainId: 480, explorer: 'https://worldscan.org', native: 'ETH', label: 'World Chain', env: 'main' },
};
/** Ambiente al que pertenece una red ('production' | 'sandbox'); null si no es conocida. */
export const envOfNetwork = (id: string): 'production' | 'sandbox' | null =>
  KNOWN[id] ? (KNOWN[id].env === 'main' ? 'production' : 'sandbox') : null;

export interface Net {
  id: string; label: string; primary: boolean; client: PublicClient; rpcUrl: string; local: boolean;
  expectedChainId: number | null; chainId: number | null; healthy: boolean; error: string | null;
  confirmations: number; gasLowWei: bigint; maxFeeWei: bigint; explorer: string | null;
  webhookId: string | null; signingKey: string | null;
}

const suffix = (id: string) => id.toUpperCase().replace(/[^A-Z0-9]/g, '_');
const env = (k: string) => { const v = process.env[k]; return v && v.trim() ? v.trim() : undefined; };
export const csv = (s: string | undefined) => (s ?? '').split(',').map((x) => x.trim()).filter(Boolean);

function build(id: string): Net {
  const S = suffix(id), primary = id === config.ALCHEMY_NETWORK, k = KNOWN[id];
  const override = env(`RPC_URL_${S}`) ?? (primary ? config.RPC_URL : undefined);
  const rpcUrl = override ?? `https://${id}.g.alchemy.com/v2/${config.ALCHEMY_API_KEY}`;
  return {
    id, label: k?.label ?? id, primary, rpcUrl, local: !!override,
    client: createPublicClient({ transport: http(rpcUrl, { retryCount: 2, timeout: 15_000, onFetchRequest: override ? undefined : () => recordUsage('alchemy', `rpc:${id}`) }) }) as PublicClient,
    // El RPC local de pruebas debe usar el mismo chainId que la red registrada.
    expectedChainId: k?.chainId ?? null, chainId: null, healthy: false, error: 'pendiente de verificación',
    confirmations: confirmationsOf(S),
    gasLowWei: BigInt(env(`GAS_LOW_WEI_${S}`) ?? config.GAS_LOW_WEI),
    maxFeeWei: BigInt(env(`GAS_BUMP_MAX_FEE_WEI_${S}`) ?? config.GAS_BUMP_MAX_FEE_WEI),
    explorer: env(`EXPLORER_URL_${S}`) ?? k?.explorer ?? null,
    webhookId: env(`ALCHEMY_WEBHOOK_ID_${S}`) ?? (primary ? config.ALCHEMY_WEBHOOK_ID ?? null : null),
    signingKey: env(`ALCHEMY_WEBHOOK_SIGNING_KEY_${S}`) ?? (primary ? config.ALCHEMY_WEBHOOK_SIGNING_KEY ?? null : null),
  };
}

function confirmationsOf(suffix: string): number {
  const value = Number(env(`CONFIRMATIONS_${suffix}`) ?? config.CONFIRMATIONS);
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`CONFIRMATIONS_${suffix} debe ser un entero positivo`);
  return value;
}

// La red principal (ALCHEMY_NETWORK) siempre va primero: conserva el comportamiento previo
const ids = [...new Set([config.ALCHEMY_NETWORK, ...csv(config.NETWORKS)])];
export const networks: Net[] = ids.map(build);
const byId = new Map(networks.map((n) => [n.id, n]));
export const primaryNet = networks[0];

export const isEnabled = (id: string) => !!byId.get(id)?.healthy;
export const networkIds = () => networks.map((n) => n.id);
export const activeNetworks = () => networks.filter((n) => n.healthy);

/** Red encendida y sana; si no, 422 network_not_supported (código ya publicado). */
export function net(id: string): Net {
  const n = byId.get(id);
  if (!n) throw new HttpError(422, `Red no habilitada en esta instalación: ${id}`, 'network_not_supported');
  if (!n.healthy) throw new HttpError(503, `Red ${n.label} fuera de servicio: ${n.error ?? 'sin conexión'}`, 'network_down');
  return n;
}
export const findNet = (id: string) => byId.get(id) ?? null;
export const explorerOf = (id: string) => byId.get(id)?.explorer ?? KNOWN[id]?.explorer ?? null;

/**
 * Al arrancar: todas las redes deben responder con su chainId esperado, incluso con RPC local.
 * No se abre el servicio con una red sin verificar.
 */
export async function verifyNetworks(log: { info: (o: object, m: string) => void; error: (o: object, m: string) => void }) {
  await Promise.all(networks.map(async (n) => {
    try {
      const id = await n.client.getChainId();
      n.chainId = id;
      if (n.expectedChainId != null && id !== n.expectedChainId) throw new Error(`chainId ${id} no coincide con ${n.expectedChainId}`);
      n.healthy = true; n.error = null;
      log.info({ network: n.id, chainId: id }, 'red encendida');
    } catch (e) {
      n.healthy = false;
      n.error = (e as Error).message.split('\n')[0].slice(0, 200);
      log.error({ network: n.id }, 'red no verificada al arrancar');
    }
  }));
  const failed = networks.filter((n) => !n.healthy);
  if (failed.length) throw new Error(`Arranque rechazado: ${failed.map((n) => `${n.id}: ${n.error}`).join('; ')}`);
}

/** chainId de la red (cacheado tras la primera lectura). */
export async function chainIdOf(n: Net) {
  if (n.chainId == null) n.chainId = await n.client.getChainId();
  if (n.expectedChainId != null && n.chainId !== n.expectedChainId) throw new Error(`chainId ${n.chainId} no coincide con ${n.expectedChainId}`);
  return n.chainId;
}

/** Vista pública (sin URL ni llaves). */
export const netView = (n: Net) => ({
  id: n.id, label: n.label, primary: n.primary, chain_id: n.chainId, healthy: n.healthy, error: n.error,
  confirmations: n.confirmations, explorer: n.explorer, webhook: !!n.webhookId && !!n.signingKey,
});
