// Fase M1 — catálogo de activos de las redes principales (dinero real).
// Contratos verificados el 15-oct-2026 en la fuente del emisor y en el explorador oficial de cada red
// (nunca escritos de memoria). Los decimales son los que reporta el propio contrato:
//   Ethereum  USDT  Tether (tether.to)                              etherscan.io   6
//             USDC  Circle (developers.circle.com)                  etherscan.io   6
//             EURe  Monerium (docs.monerium.com/tokens)             etherscan.io  18
//   Base      USDC  Circle                                          basescan.org   6
//             EURe  Monerium                                        basescan.org  18
//   Arbitrum  USDT  USDT0 de Tether (docs.usdt0.to, deployments)    arbiscan.io    6
//             USDC  Circle (USDC nativo)                            arbiscan.io    6
//             EURe  Monerium                                        arbiscan.io   18
//   BNB       USDT  Binance-Peg BSC-USD (emisor: Binance)           bscscan.com   18
//             USDC  Binance-Peg USD Coin (emisor: Binance)          bscscan.com   18
// En BNB Smart Chain ni Tether ni Circle emiten: USDT y USDC son tokens Binance-Peg (riesgo de emisor aceptado en M1).
//
// El alta es idempotente y solo para las redes encendidas en este despliegue: el sandbox nunca ve activos de main.
import { pool } from '../db.js';
import { erc20Abi, type Address } from 'viem';
import { ensureAllSystemAccounts } from '../ledger/service.js';
import { net, networkIds } from './networks.js';

export interface CatalogAsset { id: string; symbol: string; network: string; kind: 'native' | 'erc20'; contract: string | null; decimals: number; issuer: string; source?: string }

export const MAIN_ASSETS: CatalogAsset[] = [
  { id: 'ETH-MAINNET', symbol: 'ETH', network: 'eth-mainnet', kind: 'native', contract: null, decimals: 18, issuer: 'nativo' },
  { id: 'USDT-MAINNET', symbol: 'USDT', network: 'eth-mainnet', kind: 'erc20', contract: '0xdac17f958d2ee523a2206206994597c13d831ec7', decimals: 6, issuer: 'Tether' },
  { id: 'USDC-MAINNET', symbol: 'USDC', network: 'eth-mainnet', kind: 'erc20', contract: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', decimals: 6, issuer: 'Circle' },
  { id: 'EURE-MAINNET', symbol: 'EURe', network: 'eth-mainnet', kind: 'erc20', contract: '0x39b8b6385416f4ca36a20319f70d28621895279d', decimals: 18, issuer: 'Monerium' },

  { id: 'ETH-BASE', symbol: 'ETH', network: 'base-mainnet', kind: 'native', contract: null, decimals: 18, issuer: 'nativo' },
  { id: 'USDC-BASE', symbol: 'USDC', network: 'base-mainnet', kind: 'erc20', contract: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', decimals: 6, issuer: 'Circle' },
  { id: 'EURE-BASE', symbol: 'EURe', network: 'base-mainnet', kind: 'erc20', contract: '0xbf6e2966a9c3d99c9e4d069e04f7bdb9c8aa762c', decimals: 18, issuer: 'Monerium' },

  { id: 'ETH-ARB', symbol: 'ETH', network: 'arb-mainnet', kind: 'native', contract: null, decimals: 18, issuer: 'nativo' },
  { id: 'USDT-ARB', symbol: 'USDT', network: 'arb-mainnet', kind: 'erc20', contract: '0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9', decimals: 6, issuer: 'Tether (USDT0)' },
  { id: 'USDC-ARB', symbol: 'USDC', network: 'arb-mainnet', kind: 'erc20', contract: '0xaf88d065e77c8cc2239327c5edb3a432268e5831', decimals: 6, issuer: 'Circle' },
  { id: 'EURE-ARB', symbol: 'EURe', network: 'arb-mainnet', kind: 'erc20', contract: '0x0c06ccf38114ddfc35e07427b9424adcca9f44f8', decimals: 18, issuer: 'Monerium' },

  { id: 'BNB-BSC', symbol: 'BNB', network: 'bnb-mainnet', kind: 'native', contract: null, decimals: 18, issuer: 'nativo' },
  { id: 'USDT-BSC', symbol: 'USDT', network: 'bnb-mainnet', kind: 'erc20', contract: '0x55d398326f99059ff775485246999027b3197955', decimals: 18, issuer: 'Binance-Peg' },
  { id: 'USDC-BSC', symbol: 'USDC', network: 'bnb-mainnet', kind: 'erc20', contract: '0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d', decimals: 18, issuer: 'Binance-Peg' },
];

const circle = 'https://developers.circle.com/stablecoins/usdc-contract-addresses';
const tether = 'https://tether.to/en/supported-protocols/';

// Ola 1b: fuentes consultadas el 23-oct-2026. USDT sin fuente verificada queda fuera.
export const WAVE_1B_ASSETS: CatalogAsset[] = [
  { id: 'ETH-OPT', symbol: 'ETH', network: 'opt-mainnet', kind: 'native', contract: null, decimals: 18, issuer: 'nativo' },
  { id: 'USDC-OPT', symbol: 'USDC', network: 'opt-mainnet', kind: 'erc20', contract: '0x0b2c639c533813f4aa9d7837caf62653d097ff85', decimals: 6, issuer: 'Circle', source: circle },
  { id: 'POL-POLYGON', symbol: 'POL', network: 'polygon-mainnet', kind: 'native', contract: null, decimals: 18, issuer: 'nativo' },
  { id: 'USDC-POLYGON', symbol: 'USDC', network: 'polygon-mainnet', kind: 'erc20', contract: '0x3c499c542cef5e3811e1192ce70d8cc03d5c3359', decimals: 6, issuer: 'Circle', source: circle },
  { id: 'AVAX-AVAX', symbol: 'AVAX', network: 'avax-mainnet', kind: 'native', contract: null, decimals: 18, issuer: 'nativo' },
  { id: 'USDC-AVAX', symbol: 'USDC', network: 'avax-mainnet', kind: 'erc20', contract: '0xb97ef9ef8734c71904d8002f8b6bc66dd9c48a6e', decimals: 6, issuer: 'Circle', source: circle },
  { id: 'USDT-AVAX', symbol: 'USDT', network: 'avax-mainnet', kind: 'erc20', contract: '0x9702230a8ea53601f5cd2dc00fdbc13d4df4a8c7', decimals: 6, issuer: 'Tether', source: tether },
  { id: 'ETH-LINEA', symbol: 'ETH', network: 'linea-mainnet', kind: 'native', contract: null, decimals: 18, issuer: 'nativo' },
  { id: 'USDC-LINEA', symbol: 'USDC', network: 'linea-mainnet', kind: 'erc20', contract: '0x176211869ca2b568f2a7d4ee941e073a821ee1ff', decimals: 6, issuer: 'Circle', source: circle },
  { id: 'CELO-CELO', symbol: 'CELO', network: 'celo-mainnet', kind: 'native', contract: null, decimals: 18, issuer: 'nativo' },
  { id: 'USDC-CELO', symbol: 'USDC', network: 'celo-mainnet', kind: 'erc20', contract: '0xceba9300f2b948710d2653dd7b07f33a8b32118c', decimals: 6, issuer: 'Circle', source: circle },
  { id: 'USDT-CELO', symbol: 'USDT', network: 'celo-mainnet', kind: 'erc20', contract: '0x48065fbbe25f71c9282ddf5e1cd6d6a887483d5e', decimals: 6, issuer: 'Tether', source: tether },
  { id: 'ETH-UNICHAIN', symbol: 'ETH', network: 'unichain-mainnet', kind: 'native', contract: null, decimals: 18, issuer: 'nativo' },
  { id: 'USDC-UNICHAIN', symbol: 'USDC', network: 'unichain-mainnet', kind: 'erc20', contract: '0x078d782b760474a361dda0af3839290b0ef57ad6', decimals: 6, issuer: 'Circle', source: circle },
  { id: 'ETH-WORLDCHAIN', symbol: 'ETH', network: 'worldchain-mainnet', kind: 'native', contract: null, decimals: 18, issuer: 'nativo' },
  { id: 'USDC-WORLDCHAIN', symbol: 'USDC', network: 'worldchain-mainnet', kind: 'erc20', contract: '0x79a02482a880bce3f13e09da970dc34db4cd24d1', decimals: 6, issuer: 'Circle', source: circle },

  { id: 'ETH-OPT-SEPOLIA', symbol: 'ETH', network: 'opt-sepolia', kind: 'native', contract: null, decimals: 18, issuer: 'nativo' },
  { id: 'USDC-OPT-SEPOLIA', symbol: 'USDC', network: 'opt-sepolia', kind: 'erc20', contract: '0x5fd84259d66cd46123540766be93dfe6d43130d7', decimals: 6, issuer: 'Circle', source: circle },
  { id: 'POL-AMOY', symbol: 'POL', network: 'polygon-amoy', kind: 'native', contract: null, decimals: 18, issuer: 'nativo' },
  { id: 'USDC-AMOY', symbol: 'USDC', network: 'polygon-amoy', kind: 'erc20', contract: '0x41e94eb019c0762f9bfcf9fb1e58725bfb0e7582', decimals: 6, issuer: 'Circle', source: circle },
  { id: 'AVAX-FUJI', symbol: 'AVAX', network: 'avax-fuji', kind: 'native', contract: null, decimals: 18, issuer: 'nativo' },
  { id: 'USDC-FUJI', symbol: 'USDC', network: 'avax-fuji', kind: 'erc20', contract: '0x5425890298aed601595a70ab815c96711a31bc65', decimals: 6, issuer: 'Circle', source: circle },
  { id: 'ETH-LINEA-SEPOLIA', symbol: 'ETH', network: 'linea-sepolia', kind: 'native', contract: null, decimals: 18, issuer: 'nativo' },
  { id: 'USDC-LINEA-SEPOLIA', symbol: 'USDC', network: 'linea-sepolia', kind: 'erc20', contract: '0xfece4462d57bd51a6a552365a011b95f0e16d9b7', decimals: 6, issuer: 'Circle', source: circle },
  { id: 'CELO-SEPOLIA', symbol: 'CELO', network: 'celo-sepolia', kind: 'native', contract: null, decimals: 18, issuer: 'nativo' },
  { id: 'USDC-CELO-SEPOLIA', symbol: 'USDC', network: 'celo-sepolia', kind: 'erc20', contract: '0x01c5c0122039549ad1493b8220cabedd739bc44e', decimals: 6, issuer: 'Circle', source: circle },
  { id: 'ETH-UNICHAIN-SEPOLIA', symbol: 'ETH', network: 'unichain-sepolia', kind: 'native', contract: null, decimals: 18, issuer: 'nativo' },
  { id: 'USDC-UNICHAIN-SEPOLIA', symbol: 'USDC', network: 'unichain-sepolia', kind: 'erc20', contract: '0x31d0220469e10c4e71834a79b1f276d740d3768f', decimals: 6, issuer: 'Circle', source: circle },
  { id: 'ETH-WORLDCHAIN-SEPOLIA', symbol: 'ETH', network: 'worldchain-sepolia', kind: 'native', contract: null, decimals: 18, issuer: 'nativo' },
  { id: 'USDC-WORLDCHAIN-SEPOLIA', symbol: 'USDC', network: 'worldchain-sepolia', kind: 'erc20', contract: '0x66145f38cbac35ca6f1dfb4914df98f1614aea88', decimals: 6, issuer: 'Circle', source: circle },
];

export const CATALOG_ASSETS = [...MAIN_ASSETS, ...WAVE_1B_ASSETS];

/**
 * Alta idempotente de los activos de las redes encendidas. Si el activo ya existe con OTRO contrato o decimales,
 * el arranque se detiene: un error ahí acreditaría depósitos de un token equivocado.
 */
export async function ensureCatalog(log: { info: (o: object, m: string) => void }) {
  const on = new Set(networkIds());
  const wanted = CATALOG_ASSETS.filter((a) => on.has(a.network));
  if (!wanted.length) return;
  for (const a of wanted) {
    await pool.query(
      `INSERT INTO assets (id, symbol, chain, network, kind, contract_address, decimals) VALUES ($1,$2,'ethereum',$3,$4,$5,$6)
       ON CONFLICT (id) DO NOTHING`, [a.id, a.symbol, a.network, a.kind, a.contract, a.decimals]);
    const { rows: [cur] } = await pool.query('SELECT network, kind, contract_address, decimals FROM assets WHERE id = $1', [a.id]);
    if (cur) {
      if (cur.network !== a.network || cur.kind !== a.kind || (cur.contract_address?.toLowerCase() ?? null) !== a.contract || Number(cur.decimals) !== a.decimals) {
        throw new Error(`Activo ${a.id} ya existe con datos distintos al catálogo verificado (red/contrato/decimales): revisar antes de operar`);
      }
    }
    log.info({ asset: a.id, network: a.network }, 'activo del catálogo verificado');
  }

  await ensureAllSystemAccounts();
}

export async function verifyAssetDecimals(assets: readonly Pick<CatalogAsset, 'id' | 'network' | 'kind' | 'contract' | 'decimals'>[]) {
  for (const a of assets) {
    if (a.kind !== 'erc20') continue;
    if (!a.contract) throw new Error(`Activo ${a.id}: contrato ERC-20 ausente`);
    let decimals: number;
    try {
      decimals = await net(a.network).client.readContract({ address: a.contract as Address, abi: erc20Abi, functionName: 'decimals' });
    } catch {
      // Los errores del transporte pueden contener la URL RPC con credenciales.
      throw new Error(`Activo ${a.id} (${a.network}): no se pudo verificar decimals() on-chain`);
    }
    if (decimals !== a.decimals) throw new Error(`Activo ${a.id} (${a.network}): decimals() on-chain ${decimals} no coincide con catálogo ${a.decimals}`);
  }
}

/** Incluye tokens agregados por API: ningún ERC-20 activo opera con decimales sin verificar. */
export async function verifyEnabledAssetDecimals() {
  const { rows } = await pool.query<Pick<CatalogAsset, 'id' | 'network' | 'kind' | 'contract' | 'decimals'>>(
    `SELECT id, network, kind, contract_address AS contract, decimals FROM assets
     WHERE active AND network = ANY($1) AND kind = 'erc20' ORDER BY network, id`, [networkIds()]);
  await verifyAssetDecimals(rows);
}
