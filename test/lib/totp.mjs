// TOTP para pruebas (RFC 6238, SHA1, 30 s, 6 dígitos). El servidor no acepta un paso ya usado:
// `next()` devuelve el siguiente código aceptable (paso actual o siguiente) y espera si hace falta.
import { createHmac } from 'node:crypto';

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function decode(s) {
  let bits = 0, value = 0; const out = [];
  for (const ch of s.replace(/=+$/, '').toUpperCase()) {
    value = (value << 5) | B32.indexOf(ch); bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}
export function codeAt(secret, step) {
  const msg = Buffer.alloc(8); msg.writeBigUInt64BE(BigInt(step));
  const h = createHmac('sha1', decode(secret)).update(msg).digest();
  const o = h[h.length - 1] & 15;
  return String((((h[o] & 127) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3]) % 1e6).padStart(6, '0');
}
const stepNow = () => Math.floor(Date.now() / 30000);

export function totp(secret) {
  let last = -1;
  return {
    async next() {
      for (;;) {
        const s = stepNow();
        const step = [s, s + 1].find((x) => x > last);
        if (step !== undefined) { last = step; return codeAt(secret, step); }
        await new Promise((r) => setTimeout(r, 1000));
      }
    },
    wrong: () => String((Number(codeAt(secret, stepNow())) + 1) % 1e6).padStart(6, '0'),
  };
}
