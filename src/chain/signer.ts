import { HDKey, hdKeyToAccount, privateKeyToAccount } from 'viem/accounts';
import { hexToBytes, keccak256, concat, toHex, type Address, type Hex, type TransactionSerializable } from 'viem';
import { config } from '../config.js';

/**
 * Frontera de custodia. El resto del sistema solo conoce esta interfaz:
 * cambiar a MPC (Fireblocks, Fordefi, Turnkey…) = escribir otra implementación, sin tocar el flujo.
 */
export interface Signer {
  readonly kind: string;
  address(): Address;
  signTransaction(tx: TransactionSerializable): Promise<Hex>;
}

/** Direcciones de depósito por cliente (derivación HD m/44'/60'/0'/0/i). */
export interface DepositKeyring {
  readonly kind: string;
  derive(index: number): Signer;
}

// SOLO TESTNET: llave en variable de entorno. Nunca usar con fondos reales.
class LocalKeySigner implements Signer {
  readonly kind = 'local-test-key';
  constructor(private account: ReturnType<typeof privateKeyToAccount> | ReturnType<typeof hdKeyToAccount>) {}
  address() { return this.account.address; }
  signTransaction(tx: TransactionSerializable) { return this.account.signTransaction(tx); }
}

class LocalHdKeyring implements DepositKeyring {
  readonly kind = 'local-test-hd';
  private root: HDKey;
  constructor(seed: Hex) { this.root = HDKey.fromMasterSeed(hexToBytes(seed)); }
  derive(index: number): Signer {
    return new LocalKeySigner(hdKeyToAccount(this.root, { addressIndex: index }));
  }
}

const guardTestnet = () => {
  if (config.ALCHEMY_NETWORK.includes('mainnet')) {
    throw new Error('Llaves locales prohibidas en mainnet: configure un proveedor MPC');
  }
};

let signer: Signer | null | undefined;
export function getSigner(): Signer | null {
  if (signer === undefined) {
    if (config.SIGNER_PRIVATE_KEY) guardTestnet();
    signer = config.SIGNER_PRIVATE_KEY ? new LocalKeySigner(privateKeyToAccount(config.SIGNER_PRIVATE_KEY as Hex)) : null;
  }
  return signer;
}

let keyring: DepositKeyring | null | undefined;
export function getDepositKeyring(): DepositKeyring | null {
  if (keyring === undefined) {
    let seed = config.DEPOSIT_HD_SEED as Hex | undefined;
    // Separación de dominio: la semilla derivada nunca coincide con la llave de la hot wallet
    if (!seed && config.SIGNER_PRIVATE_KEY) seed = keccak256(concat([toHex('856-latam/deposit-hd/v1'), config.SIGNER_PRIVATE_KEY as Hex]));
    if (seed) guardTestnet();
    keyring = seed ? new LocalHdKeyring(seed) : null;
  }
  return keyring;
}
