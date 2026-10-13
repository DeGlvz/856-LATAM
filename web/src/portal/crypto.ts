// Llaves Ed25519 fabricadas en el dispositivo del cliente (WebCrypto + CSPRNG del navegador).
// 856 recibe solo la pública y la firma del reto; la privada se entrega UNA vez, cifrada con la frase del cliente.
const b64u = (buf: ArrayBuffer | Uint8Array) => {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = ''; for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

export const ed25519Supported = async () => {
  try { await crypto.subtle.generateKey({ name: 'Ed25519' }, false, ['sign', 'verify']); return true; } catch { return false; }
};

export async function newEd25519() {
  // Exportable solo para entregarla cifrada una vez; después se descarta de la memoria de la página
  return crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']) as Promise<CryptoKeyPair>;
}

export async function publicRaw(pair: CryptoKeyPair) { return b64u(await crypto.subtle.exportKey('raw', pair.publicKey)); }

export async function signProof(pair: CryptoKeyPair, message: string) {
  return b64u(await crypto.subtle.sign({ name: 'Ed25519' }, pair.privateKey, new TextEncoder().encode(message)));
}

/** PKCS#8 cifrado con AES-256-GCM; llave derivada de la frase con PBKDF2-SHA256 (600 000 iteraciones). */
export async function encryptPrivate(pair: CryptoKeyPair, passphrase: string, prefix: string) {
  const pkcs8 = await crypto.subtle.exportKey('pkcs8', pair.privateKey);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(passphrase), 'PBKDF2', false, ['deriveKey']);
  const aes = await crypto.subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: 600_000 }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt']);
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: new TextEncoder().encode(prefix) }, aes, pkcs8);
  return JSON.stringify({
    format: '856-latam/ed25519-key/v1', prefix, created_at: new Date().toISOString(),
    kdf: { name: 'PBKDF2-SHA256', iterations: 600_000, salt: b64u(salt) }, cipher: { name: 'AES-256-GCM', iv: b64u(iv), aad: 'prefix', ct: b64u(ct) },
  }, null, 2);
}

export function download(name: string, text: string) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  a.download = name; a.click(); URL.revokeObjectURL(a.href);
}
