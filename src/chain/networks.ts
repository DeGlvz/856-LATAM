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
  // Fase M1 — redes principales (dinero real)
  'eth-mainnet': { chainId: 1, explorer: 'https://etherscan.io', native: 'ETH', label: 'Ethereum', env: 'main' },
  'base-mainnet': { chainId: 8453, explorer: 'https://basescan.org', native: 'ETH', label: 'Base', env: 'main' },
  'arb-mainnet': { chainId: 42161, explorer: 'https://arbiscan.io', native: 'ETH', label: 'Arbitrum One', env: 'main' },
  'bnb-mainnet': { chainId: 56, explorer: 'https://bscscan.com', native: 'BNB', label: 'BNB Smart Chain', env: 'main' },
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
    client: createPublicClient({ transport: http(rpcUrl, { retryCount: 2, timeout: 15_000 }) }) as PublicClient,
    // Con RPC propio (cadena local de pruebas) no se exige el chainId público, salvo en production (M1): ahí siempre
    expectedChainId: override && config.ENVIRONMENT !== 'production' ? null : k?.chainId ?? null, chainId: null, healthy: true, error: null,
    confirmations: Number(env(`CONFIRMATIONS_${S}`) ?? config.CONFIRMATIONS),
    gasLowWei: BigInt(env(`GAS_LOW_WEI_${S}`) ?? config.GAS_LOW_WEI),
    maxFeeWei: BigInt(env(`GAS_BUMP_MAX_FEE_WEI_${S}`) ?? config.GAS_BUMP_MAX_FEE_WEI),
    explorer: env(`EXPLORER_URL_${S}`) ?? k?.explorer ?? null,
    webhookId: env(`ALCHEMY_WEBHOOK_ID_${S}`) ?? (primary ? config.ALCHEMY_WEBHOOK_ID ?? null : null),
    signingKey: env(`ALCHEMY_WEBHOOK_SIGNING_KEY_${S}`) ?? (primary ? config.ALCHEMY_WEBHOOK_SIGNING_KEY ?? null : null),
  };
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
 * Al arrancar: lee el chainId de cada red. Si no coincide con el público esperado, la red NO se enciende
 * (protege contra una URL mal configurada que firmaría en otra cadena). Una red sin conexión queda marcada
 * y se reintenta en cada ciclo del worker.
 */
export async function verifyNetworks(log: { info: (o: object, m: string) => void; error: (o: object, m: string) => void }) {
  await Promise.all(networks.map(async (n) => {
    try {
      const id = await n.client.getChainId();
      n.chainId = id;
      if (n.expectedChainId != null && id !== n.expectedChainId) {
        n.healthy = false; n.error = `chainId ${id} no coincide con ${n.expectedChainId}`;
        log.error({ network: n.id, chainId: id, expected: n.expectedChainId }, 'red desactivada: chainId inesperado');
      } else {
        n.healthy = true; n.error = null;
        log.info({ network: n.id, chainId: id }, 'red encendida');
      }
    } catch (e) {
      n.error = (e as Error).message.split('\n')[0].slice(0, 200);
      log.error({ network: n.id, err: n.error }, 'red sin conexión al arrancar; se reintenta en el worker');
    }
  }));
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
