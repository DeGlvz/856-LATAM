import { privateKeyToAccount } from 'viem/accounts';
import type { Address, Hex, TransactionSerializable } from 'viem';
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

// SOLO TESTNET: llave en variable de entorno. Nunca usar con fondos reales.
class LocalKeySigner implements Signer {
  readonly kind = 'local-test-key';
  private account;
  constructor(pk: Hex) { this.account = privateKeyToAccount(pk); }
  address() { return this.account.address; }
  signTransaction(tx: TransactionSerializable) { return this.account.signTransaction(tx); }
}

let signer: Signer | null | undefined;
export function getSigner(): Signer | null {
  if (signer === undefined) {
    signer = config.SIGNER_PRIVATE_KEY ? new LocalKeySigner(config.SIGNER_PRIVATE_KEY as Hex) : null;
    if (signer && config.ALCHEMY_NETWORK.includes('mainnet')) {
      throw new Error('LocalKeySigner está prohibido en mainnet: configure un proveedor MPC');
    }
  }
  return signer;
}
