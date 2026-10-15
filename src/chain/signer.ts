import { HDKey, hdKeyToAccount, mnemonicToAccount, privateKeyToAccount } from 'viem/accounts';
import { hexToBytes, keccak256, concat, toHex, type Address, type Hex, type TransactionSerializable } from 'viem';
import { config, isProduction } from '../config.js';

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

// Llave en variable de entorno. Fase M1: permitida en production por decisión de negocio (llaves pegadas en Railway,
// distintas a las del sandbox); el riesgo de hot wallet con llave en variable está aceptado y documentado en el README.
// La interfaz Signer queda lista para sustituirla por MPC sin tocar el flujo.
class LocalKeySigner implements Signer {
  readonly kind = isProduction ? 'local-env-key' : 'local-test-key';
  constructor(private account: ReturnType<typeof privateKeyToAccount> | ReturnType<typeof hdKeyToAccount> | ReturnType<typeof mnemonicToAccount>) {}
  address() { return this.account.address; }
  signTransaction(tx: TransactionSerializable) { return this.account.signTransaction(tx); }
}

class LocalHdKeyring implements DepositKeyring {
  readonly kind = isProduction ? 'local-env-hd' : 'local-test-hd';
  private root: HDKey | null;
  constructor(seed: Hex | null, private mnemonic: string | null = null) { this.root = seed ? HDKey.fromMasterSeed(hexToBytes(seed)) : null; }
  derive(index: number): Signer {
    // m/44'/60'/0'/0/i en ambos casos
    return new LocalKeySigner(this.mnemonic ? mnemonicToAccount(this.mnemonic, { addressIndex: index }) : hdKeyToAccount(this.root!, { addressIndex: index }));
  }
}

/**
 * Fase M1: llaves locales en una red main solo con ENVIRONMENT=production (cuyo arranque exige semilla HD propia);
 * nunca en un sandbox apuntado por error a main.
 */
const guardEnvironment = () => {
  if (!isProduction && /mainnet/.test(config.ALCHEMY_NETWORK)) {
    throw new Error('Llaves locales en una red main fuera de ENVIRONMENT=production: configuración rechazada');
  }
};

let signer: Signer | null | undefined;
export function getSigner(): Signer | null {
  if (signer === undefined) {
    if (config.SIGNER_PRIVATE_KEY) guardEnvironment();
    signer = config.SIGNER_PRIVATE_KEY ? new LocalKeySigner(privateKeyToAccount(config.SIGNER_PRIVATE_KEY as Hex)) : null;
  }
  return signer;
}

let keyring: DepositKeyring | null | undefined;
export function getDepositKeyring(): DepositKeyring | null {
  if (keyring === undefined) {
    let seed = config.DEPOSIT_HD_SEED as Hex | undefined;
    const mnemonic = config.HD_MNEMONIC ?? null;
    // Solo sandbox: si no hay semilla propia, se deriva de la llave de la hot wallet (separación de dominio).
    // En production el arranque exige HD_MNEMONIC o DEPOSIT_HD_SEED (ver src/environment.ts).
    if (!seed && !mnemonic && config.SIGNER_PRIVATE_KEY && !isProduction) {
      seed = keccak256(concat([toHex('856-latam/deposit-hd/v1'), config.SIGNER_PRIVATE_KEY as Hex]));
    }
    if (seed || mnemonic) guardEnvironment();
    keyring = seed || mnemonic ? new LocalHdKeyring(seed ?? null, mnemonic) : null;
  }
  return keyring;
}
