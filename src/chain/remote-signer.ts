import { createHmac, randomBytes } from 'node:crypto';
import { HDKey, publicKeyToAddress } from 'viem/accounts';
import {
  keccak256, serializeTransaction, toHex, type Address, type Hex, type TransactionSerializable,
} from 'viem';
import type { DepositKeyring, Signer } from './signer.js';

/**
 * Firmante remoto (SIGNER_BACKEND=remote): la app NO tiene llaves.
 * Las llaves (hot wallet y semilla HD) viven en el servicio firmante (src/signer-service), en otro droplet,
 * accesible solo por la red privada. La app envía la transacción sin firmar (serializada) y recibe la firma.
 *
 * Autenticación: HMAC-SHA256 sobre `${ts}.${nonce}.${método}.${ruta}.${cuerpo}` con un secreto compartido
 * (SIGNER_REMOTE_SECRET). El firmante rechaza firmas fuera de ventana (±60 s) y nonces repetidos.
 */

export type KeyRef = { kind: 'hot' } | { kind: 'deposit'; index: number };

export interface RemoteClientOptions { url: string; secret: string; timeoutMs?: number; fetchImpl?: typeof fetch }

export function signRequest(secret: string, method: string, path: string, body: string, ts = Math.floor(Date.now() / 1000), nonce = randomBytes(16).toString('hex')) {
  const mac = createHmac('sha256', secret).update(`${ts}.${nonce}.${method}.${path}.${body}`).digest('hex');
  return { 'x-856-ts': String(ts), 'x-856-nonce': nonce, 'x-856-sig': mac };
}

export class RemoteSignerClient {
  private base: string;
  private fetchImpl: typeof fetch;
  constructor(private opts: RemoteClientOptions) {
    this.base = opts.url.replace(/\/+$/, '');
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  async call<T>(method: 'GET' | 'POST', path: string, payload?: unknown): Promise<T> {
    const body = payload === undefined ? '' : JSON.stringify(payload);
    const res = await this.fetchImpl(this.base + path, {
      method,
      headers: { 'content-type': 'application/json', ...signRequest(this.opts.secret, method, path, body) },
      body: method === 'POST' ? body : undefined,
      signal: AbortSignal.timeout(this.opts.timeoutMs ?? 10_000),
    });
    const text = await res.text();
    let data: any;
    try { data = text ? JSON.parse(text) : {}; } catch { data = { error: text }; }
    if (!res.ok) throw new Error(`Firmante remoto rechazó ${path} (${res.status}): ${data?.error ?? 'sin detalle'}`);
    return data as T;
  }

  info() { return this.call<{ hot: Address; xpub: string; locked: boolean }>('GET', '/v1/info'); }
}

/** Una llave del firmante remoto (hot wallet o dirección de depósito i). La dirección se conoce sin la llave. */
export class RemoteSigner implements Signer {
  readonly kind = 'remote';
  constructor(private client: RemoteSignerClient, private ref: KeyRef, private addr: Address) {}
  address() { return this.addr; }

  async signTransaction(tx: TransactionSerializable): Promise<Hex> {
    const unsigned = serializeTransaction(tx);
    const { signed } = await this.client.call<{ signed: Hex }>('POST', '/v1/sign/tx', { ref: this.ref, from: this.addr, unsigned });
    // Defensa: el firmante debe devolver exactamente la transacción pedida, firmada por la dirección esperada
    await assertSignedMatches(unsigned, signed, this.addr);
    return signed;
  }

  async signMessage(message: string): Promise<Hex> {
    const { signature } = await this.client.call<{ signature: Hex }>('POST', '/v1/sign/message', { ref: this.ref, from: this.addr, message });
    const { verifyMessage } = await import('viem');
    if (!(await verifyMessage({ address: this.addr, message, signature }))) throw new Error('La firma remota del mensaje no corresponde a la dirección');
    return signature;
  }
}

/** Verifica que `signed` sea la misma transacción que `unsigned` y que la firme `from`. */
export async function assertSignedMatches(unsigned: Hex, signed: Hex, from: Address) {
  const { parseTransaction, recoverTransactionAddress } = await import('viem');
  const a = parseTransaction(unsigned) as any;
  const b = parseTransaction(signed) as any;
  for (const k of ['chainId', 'nonce', 'to', 'value', 'data', 'gas', 'maxFeePerGas', 'maxPriorityFeePerGas', 'type'] as const) {
    if (String(a[k] ?? '') !== String(b[k] ?? '')) throw new Error(`El firmante remoto alteró la transacción (${k})`);
  }
  const rec = await recoverTransactionAddress({ serializedTransaction: signed as any });
  if (rec.toLowerCase() !== from.toLowerCase()) throw new Error('La transacción firmada no corresponde a la dirección esperada');
}

/** Direcciones de depósito derivadas de la xpub del nodo m/44'/60'/0'/0 (solo llaves públicas). */
export class RemoteHdKeyring implements DepositKeyring {
  readonly kind = 'remote-hd';
  private node: HDKey;
  private cache = new Map<number, RemoteSigner>();
  constructor(private client: RemoteSignerClient, xpub: string) {
    this.node = HDKey.fromExtendedKey(xpub);
    if (this.node.privateKey) throw new Error('DEPOSIT_HD_XPUB contiene una llave privada (xprv): solo se acepta la xpub');
    if (this.node.depth !== 4) throw new Error("La xpub debe ser del nodo m/44'/60'/0'/0 (profundidad 4)");
  }
  derive(index: number): Signer {
    let s = this.cache.get(index);
    if (!s) {
      const child = this.node.deriveChild(index);
      const addr = publicKeyToAddress(toHex(uncompress(child.publicKey!)));
      s = new RemoteSigner(this.client, { kind: 'deposit', index }, addr);
      this.cache.set(index, s);
    }
    return s;
  }
}

/** Llave pública comprimida (33 bytes) → sin comprimir (65 bytes, 0x04‖x‖y), como la espera publicKeyToAddress. */
function uncompress(pub: Uint8Array): Uint8Array {
  if (pub.length === 65) return pub;
  const P = 0xfffffffffffffffffffffffffffffffffffffffffffffffffffffffefffffc2fn;
  const x = BigInt(toHex(pub.subarray(1)));
  const y2 = (x ** 3n + 7n) % P;
  let y = modPow(y2, (P + 1n) / 4n, P);
  if ((y & 1n) !== BigInt(pub[0] & 1)) y = P - y;
  const hex = (n: bigint) => n.toString(16).padStart(64, '0');
  return Uint8Array.from(Buffer.from(`04${hex(x)}${hex(y)}`, 'hex'));
}
function modPow(b: bigint, e: bigint, m: bigint) {
  let r = 1n; b %= m;
  while (e > 0n) { if (e & 1n) r = (r * b) % m; b = (b * b) % m; e >>= 1n; }
  return r;
}

export const _test = { uncompress, keccak256 };
