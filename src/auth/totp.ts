// TOTP (RFC 6238: HMAC-SHA1, 30 s, 6 dígitos) sin dependencias, y cifrado del secreto en reposo.
import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { config } from '../config.js';
import { HttpError } from '../idempotency.js';

const STEP = 30;
const DIGITS = 6;
const WINDOW = 1; // ±30 s de tolerancia de reloj
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(buf: Buffer): string {
  let bits = 0, value = 0, out = '';
  for (const byte of buf) {
    value = (value << 8) | byte; bits += 8;
    while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(s: string): Buffer {
  const clean = s.replace(/=+$/, '').replace(/\s+/g, '').toUpperCase();
  let bits = 0, value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const i = B32.indexOf(ch);
    if (i < 0) throw new Error('base32 inválido');
    value = (value << 5) | i; bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}

export const currentStep = (now = Date.now()) => Math.floor(now / 1000 / STEP);

export function codeAt(secretB32: string, step: number): string {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(step));
  const h = createHmac('sha1', base32Decode(secretB32)).update(msg).digest();
  const off = h[h.length - 1] & 0x0f;
  const bin = ((h[off] & 0x7f) << 24) | (h[off + 1] << 16) | (h[off + 2] << 8) | h[off + 3];
  return String(bin % 10 ** DIGITS).padStart(DIGITS, '0');
}

/** Devuelve el paso de tiempo que coincide (para anti-reuso) o null. Nunca acepta un paso ≤ lastStep. */
export function verifyCode(secretB32: string, code: string, lastStep: number | null, now = Date.now()): number | null {
  if (!/^\d{6}$/.test(code)) return null;
  const s = currentStep(now);
  for (let d = -WINDOW; d <= WINDOW; d++) {
    const step = s + d;
    if (lastStep != null && step <= lastStep) continue;
    const a = Buffer.from(codeAt(secretB32, step)), b = Buffer.from(code);
    if (timingSafeEqual(a, b)) return step;
  }
  return null;
}

export const generateSecret = () => base32Encode(randomBytes(20));

export const otpauthUrl = (secret: string, account: string) =>
  `otpauth://totp/${encodeURIComponent(`${config.TOTP_ISSUER}:${account}`)}?secret=${secret}&issuer=${encodeURIComponent(config.TOTP_ISSUER)}&algorithm=SHA1&digits=${DIGITS}&period=${STEP}`;

// ───────────── Cifrado en reposo ─────────────
function key(): Buffer {
  if (!config.TOTP_ENCRYPTION_KEY) {
    throw new HttpError(503, 'El servidor no tiene configurada TOTP_ENCRYPTION_KEY: no se puede usar 2FA', 'totp_not_configured');
  }
  return createHash('sha256').update(config.TOTP_ENCRYPTION_KEY).digest();
}

export function encryptSecret(plain: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key(), iv);
  const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return ['v1', iv.toString('base64url'), c.getAuthTag().toString('base64url'), ct.toString('base64url')].join(':');
}

export function decryptSecret(enc: string): string {
  const [v, iv, tag, ct] = enc.split(':');
  if (v !== 'v1') throw new Error('Formato de secreto desconocido');
  const d = createDecipheriv('aes-256-gcm', key(), Buffer.from(iv, 'base64url'));
  d.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([d.update(Buffer.from(ct, 'base64url')), d.final()]).toString('utf8');
}
