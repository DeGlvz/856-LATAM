import { GetPublicKeyCommand, SignCommand } from '@aws-sdk/client-kms';
import {
  bytesToHex, hashMessage, hexToBytes, keccak256, recoverAddress, serializeSignature, serializeTransaction,
  type Address, type Hex, type TransactionSerializable,
} from 'viem';
import type { Signer } from './signer.js';

/** Superficie mínima del cliente KMS (permite un doble en pruebas). */
export interface KmsLike { send(command: GetPublicKeyCommand | SignCommand): Promise<any> }

const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n; // orden de secp256k1
const HALF_N = N >> 1n;

/** Lee un TLV DER; devuelve [valor, siguiente posición]. */
function readTlv(b: Uint8Array, pos: number, tag: number): [Uint8Array, number] {
  if (b[pos] !== tag) throw new Error('DER inválido');
  let len = b[pos + 1];
  let off = pos + 2;
  if (len & 0x80) {
    const n = len & 0x7f;
    len = 0;
    for (let i = 0; i < n; i++) len = (len << 8) | b[off + i];
    off += n;
  }
  if (off + len > b.length) throw new Error('DER truncado');
  return [b.subarray(off, off + len), off + len];
}

/** Firma ECDSA DER (SEQUENCE { INTEGER r, INTEGER s }) → r, s. */
export function parseDerSignature(der: Uint8Array): { r: bigint; s: bigint } {
  const [seq] = readTlv(der, 0, 0x30);
  const [r, next] = readTlv(seq, 0, 0x02);
  const [s] = readTlv(seq, next, 0x02);
  const big = (x: Uint8Array) => BigInt(bytesToHex(x));
  return { r: big(r), s: big(s) };
}

/** Llave pública SPKI (DER) → dirección EVM: keccak256 del punto sin prefijo 0x04, últimos 20 bytes. */
export function addressFromSpki(spki: Uint8Array): Address {
  const point = spki.subarray(spki.length - 65);
  if (point.length !== 65 || point[0] !== 0x04) throw new Error('La llave KMS no es un punto secp256k1 sin comprimir');
  return `0x${keccak256(point.subarray(1)).slice(-40)}` as Address;
}

const to32 = (x: bigint) => `0x${x.toString(16).padStart(64, '0')}` as Hex;

/**
 * Hot wallet con la llave en AWS KMS (ECC_SECG_P256K1, SIGN_VERIFY): la llave privada nunca sale de KMS.
 * Se firma el hash (MessageType DIGEST, ECDSA_SHA_256 = firma directa del digest de 32 bytes).
 */
export class KmsSigner implements Signer {
  readonly kind = 'kms';
  private constructor(private client: KmsLike, private keyId: string, private addr: Address) {}

  static async create(client: KmsLike, keyId: string): Promise<KmsSigner> {
    const res = await client.send(new GetPublicKeyCommand({ KeyId: keyId }));
    if (!res.PublicKey) throw new Error('KMS no devolvió la llave pública');
    return new KmsSigner(client, keyId, addressFromSpki(res.PublicKey));
  }

  address() { return this.addr; }

  private async signHash(hash: Hex) {
    const res = await this.client.send(new SignCommand({
      KeyId: this.keyId, Message: hexToBytes(hash), MessageType: 'DIGEST', SigningAlgorithm: 'ECDSA_SHA_256',
    }));
    if (!res.Signature) throw new Error('KMS no devolvió la firma');
    const { r, s: raw } = parseDerSignature(res.Signature);
    const s = raw > HALF_N ? N - raw : raw; // EIP-2: s bajo
    const R = to32(r);
    const S = to32(s);
    for (const yParity of [0, 1] as const) {
      const rec = await recoverAddress({ hash, signature: { r: R, s: S, yParity } }).catch(() => null);
      if (rec && rec.toLowerCase() === this.addr.toLowerCase()) return { r: R, s: S, yParity };
    }
    throw new Error('La firma de KMS no recupera la dirección de la hot wallet');
  }

  async signTransaction(tx: TransactionSerializable): Promise<Hex> {
    const sig = await this.signHash(keccak256(serializeTransaction(tx)));
    // tx legacy: viem calcula v (EIP-155) a partir de 27 + yParity
    return serializeTransaction(tx, { ...sig, v: 27n + BigInt(sig.yParity) });
  }

  async signMessage(message: string): Promise<Hex> {
    return serializeSignature(await this.signHash(hashMessage(message)));
  }
}
