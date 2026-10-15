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
import { ensureAllSystemAccounts } from '../ledger/service.js';
import { networkIds } from './networks.js';

export interface CatalogAsset { id: string; symbol: string; network: string; kind: 'native' | 'erc20'; contract: string | null; decimals: number; issuer: string }

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

/**
 * Alta idempotente de los activos de las redes encendidas. Si el activo ya existe con OTRO contrato o decimales,
 * el arranque se detiene: un error ahí acreditaría depósitos de un token equivocado.
 */
export async function ensureCatalog(log: { info: (o: object, m: string) => void }) {
  const on = new Set(networkIds());
  const wanted = MAIN_ASSETS.filter((a) => on.has(a.network));
  if (!wanted.length) return;
  for (const a of wanted) {
    const { rows: [cur] } = await pool.query('SELECT network, kind, contract_address, decimals FROM assets WHERE id = $1', [a.id]);
    if (cur) {
      if (cur.network !== a.network || cur.kind !== a.kind || (cur.contract_address ?? null) !== a.contract || Number(cur.decimals) !== a.decimals) {
        throw new Error(`Activo ${a.id} ya existe con datos distintos al catálogo verificado (red/contrato/decimales): revisar antes de operar`);
      }
      continue;
    }
    await pool.query(
      `INSERT INTO assets (id, symbol, chain, network, kind, contract_address, decimals) VALUES ($1,$2,'ethereum',$3,$4,$5,$6)
       ON CONFLICT (id) DO NOTHING`, [a.id, a.symbol, a.network, a.kind, a.contract, a.decimals]);
    log.info({ asset: a.id, network: a.network }, 'activo de main dado de alta');
  }
  await ensureAllSystemAccounts();
}
