import { createCipheriv, createDecipheriv, pbkdf2Sync, randomBytes, scryptSync } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, renameSync } from 'node:fs';
import { HDKey, english, generateMnemonic, generatePrivateKey, mnemonicToAccount, privateKeyToAccount } from 'viem/accounts';
import type { Address, Hex } from 'viem';

/**
 * Almacén de llaves del firmante. En disco solo hay texto cifrado (scrypt + AES-256-GCM) y los datos públicos
 * (dirección de la hot wallet y xpub). La contraseña la escribe el operador al desbloquear; nunca se guarda.
 */

export interface Secrets { hotKey: Hex; mnemonic: string }
export interface KeystoreFile {
  v: 1;
  hot: Address;                    // público
  xpub: string;                    // público: nodo m/44'/60'/0'/0
  createdAt: string;
  kdf: { name: 'scrypt'; salt: string; N: number; r: number; p: number };
  cipher: { name: 'aes-256-gcm'; iv: string; tag: string; ct: string };
}

const KDF = { N: 2 ** 15, r: 8, p: 1 }; // ~32 MB de memoria: viable en un droplet de 1 GB
export const DEPOSIT_PATH = "m/44'/60'/0'/0";

function deriveKey(pass: string, salt: Buffer, k = KDF) {
  return scryptSync(pass.normalize('NFKC'), salt, 32, { N: k.N, r: k.r, p: k.p, maxmem: 256 * 1024 * 1024 });
}

/** Semilla BIP-39: PBKDF2-HMAC-SHA512(frase NFKD, "mnemonic", 2048, 64). */
const mnemonicToSeedSync = (m: string) => pbkdf2Sync(m.normalize('NFKD'), 'mnemonic', 2048, 64, 'sha512');

export function publicInfo(s: Secrets): { hot: Address; xpub: string } {
  const hot = privateKeyToAccount(s.hotKey).address;
  const node = HDKey.fromMasterSeed(mnemonicToSeedSync(s.mnemonic)).derive(DEPOSIT_PATH);
  return { hot, xpub: node.publicExtendedKey };
}

export function encrypt(s: Secrets, pass: string): KeystoreFile {
  if (pass.length < 16) throw new Error('La contraseña del almacén debe tener al menos 16 caracteres');
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = deriveKey(pass, salt);
  const c = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([c.update(JSON.stringify(s), 'utf8'), c.final()]);
  return {
    v: 1, ...publicInfo(s), createdAt: new Date().toISOString(),
    kdf: { name: 'scrypt', salt: salt.toString('hex'), ...KDF },
    cipher: { name: 'aes-256-gcm', iv: iv.toString('hex'), tag: c.getAuthTag().toString('hex'), ct: ct.toString('hex') },
  };
}

export function decrypt(f: KeystoreFile, pass: string): Secrets {
  const key = deriveKey(pass, Buffer.from(f.kdf.salt, 'hex'), f.kdf);
  const d = createDecipheriv('aes-256-gcm', key, Buffer.from(f.cipher.iv, 'hex'));
  d.setAuthTag(Buffer.from(f.cipher.tag, 'hex'));
  let plain: string;
  try {
    plain = Buffer.concat([d.update(Buffer.from(f.cipher.ct, 'hex')), d.final()]).toString('utf8');
  } catch {
    throw new Error('Contraseña incorrecta o almacén alterado');
  }
  const s = JSON.parse(plain) as Secrets;
  const pub = publicInfo(s);
  if (pub.hot.toLowerCase() !== f.hot.toLowerCase() || pub.xpub !== f.xpub) throw new Error('El almacén no coincide con sus datos públicos');
  return s;
}

/** Genera llaves NUEVAS (hot wallet + frase de 24 palabras). Se usan solo al inicializar el firmante. */
export function generateSecrets(): Secrets {
  return { hotKey: generatePrivateKey(), mnemonic: generateMnemonic(english, 256) };
}

export function readKeystore(path: string): KeystoreFile {
  return JSON.parse(readFileSync(path, 'utf8')) as KeystoreFile;
}

export function writeKeystore(path: string, f: KeystoreFile) {
  if (existsSync(path)) throw new Error(`Ya existe un almacén en ${path}; no se sobrescribe`);
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(f, null, 2), { mode: 0o600 });
  renameSync(tmp, path);
}

/** Cuenta de depósito i (m/44'/60'/0'/0/i) a partir de la frase. */
export const depositAccount = (s: Secrets, index: number) => mnemonicToAccount(s.mnemonic, { addressIndex: index });
export const hotAccount = (s: Secrets) => privateKeyToAccount(s.hotKey);
