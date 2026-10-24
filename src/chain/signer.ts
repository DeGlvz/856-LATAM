import { HDKey, hdKeyToAccount, mnemonicToAccount, privateKeyToAccount } from 'viem/accounts';
import { hexToBytes, keccak256, concat, toHex, type Address, type Hex, type TransactionSerializable } from 'viem';
import { KMSClient } from '@aws-sdk/client-kms';
import { config, isProduction } from '../config.js';
import { KmsSigner, type KmsLike } from './kms-signer.js';
import { RemoteHdKeyring, RemoteSigner, RemoteSignerClient } from './remote-signer.js';

/**
 * Frontera de custodia. El resto del sistema solo conoce esta interfaz:
 * cambiar a MPC (Fireblocks, Fordefi, Turnkey…) = escribir otra implementación, sin tocar el flujo.
 */
export interface Signer {
  readonly kind: string;
  address(): Address;
  signTransaction(tx: TransactionSerializable): Promise<Hex>;
  /** Firma de mensaje (EIP-191, personal_sign): no es transacción ni cuesta gas. Fase F1: prueba de propiedad ante el proveedor fiat. */
  signMessage(message: string): Promise<Hex>;
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
  signMessage(message: string) { return this.account.signMessage({ message }); }
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

/** Se llama una vez al arrancar (antes del worker): con SIGNER_BACKEND=kms consulta la llave pública a KMS. */
export async function initSigner(kmsClient?: KmsLike, remoteClient?: RemoteSignerClient): Promise<Signer | null> {
  if (config.SIGNER_BACKEND === 'remote') {
    // La app no tiene llaves: hot wallet y semilla HD viven en el servicio firmante (otro droplet, red privada)
    if (!config.SIGNER_REMOTE_URL || !config.SIGNER_REMOTE_SECRET) throw new Error('SIGNER_BACKEND=remote exige SIGNER_REMOTE_URL y SIGNER_REMOTE_SECRET');
    const client = remoteClient ?? new RemoteSignerClient({ url: config.SIGNER_REMOTE_URL, secret: config.SIGNER_REMOTE_SECRET });
    const info = await client.info();
    // Anclaje: si el firmante fuera sustituido, sus direcciones no coincidirían con las fijadas en la app
    if (config.SIGNER_REMOTE_HOT_ADDRESS && config.SIGNER_REMOTE_HOT_ADDRESS.toLowerCase() !== info.hot.toLowerCase()) {
      throw new Error(`El firmante remoto reporta la hot wallet ${info.hot}, distinta de SIGNER_REMOTE_HOT_ADDRESS`);
    }
    if (config.DEPOSIT_HD_XPUB && config.DEPOSIT_HD_XPUB !== info.xpub) throw new Error('El firmante remoto reporta una xpub distinta de DEPOSIT_HD_XPUB');
    signer = new RemoteSigner(client, { kind: 'hot' }, info.hot);
    keyring = new RemoteHdKeyring(client, config.DEPOSIT_HD_XPUB ?? info.xpub);
    return signer;
  }
  if (config.SIGNER_BACKEND === 'kms') {
    if (!config.SIGNER_KMS_KEY_ID) throw new Error('SIGNER_BACKEND=kms exige SIGNER_KMS_KEY_ID');
    signer = await KmsSigner.create(kmsClient ?? new KMSClient({}), config.SIGNER_KMS_KEY_ID);
  } else {
    if (config.SIGNER_PRIVATE_KEY) guardEnvironment();
    signer = config.SIGNER_PRIVATE_KEY ? new LocalKeySigner(privateKeyToAccount(config.SIGNER_PRIVATE_KEY as Hex)) : null;
  }
  return signer;
}

export function getSigner(): Signer | null {
  if (signer === undefined) {
    if (config.SIGNER_BACKEND !== 'local') throw new Error(`Firmante ${config.SIGNER_BACKEND} sin inicializar: initSigner() debe completarse al arrancar`);
    if (config.SIGNER_PRIVATE_KEY) guardEnvironment();
    signer = config.SIGNER_PRIVATE_KEY ? new LocalKeySigner(privateKeyToAccount(config.SIGNER_PRIVATE_KEY as Hex)) : null;
  }
  return signer;
}

let keyring: DepositKeyring | null | undefined;
export function getDepositKeyring(): DepositKeyring | null {
  if (config.SIGNER_BACKEND === 'remote') {
    if (keyring === undefined) throw new Error('Firmante remoto sin inicializar: initSigner() debe completarse al arrancar');
    return keyring;
  }
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
