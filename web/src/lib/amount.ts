// Montos en unidades base (string entero) → texto. Solo BigInt: nunca Number/float.
const group = (s: string) => s.replace(/\B(?=(\d{3})+(?!\d))/g, ',');

export function toBig(v: string | null | undefined): bigint | null {
  if (v == null || !/^-?\d+$/.test(v)) return null;
  return BigInt(v);
}

/** Formatea `base` con `decimals`; trunca (no redondea) a `maxFrac` decimales para no sobrestimar. */
export function formatUnits(base: string | bigint | null | undefined, decimals: number, maxFrac = 6): string {
  const v = typeof base === 'bigint' ? base : toBig(base ?? null);
  if (v == null) return '—';
  const neg = v < 0n;
  const abs = neg ? -v : v;
  const scale = 10n ** BigInt(decimals);
  const int = abs / scale;
  let frac = decimals > 0 ? (abs % scale).toString().padStart(decimals, '0') : '';
  frac = frac.slice(0, maxFrac).replace(/0+$/, '');
  const truncated = decimals > maxFrac && abs % 10n ** BigInt(decimals - maxFrac) !== 0n;
  const s = `${group(int.toString())}${frac ? `.${frac}` : ''}`;
  return `${neg ? '−' : ''}${truncated && s === '0' ? '<0.' + '0'.repeat(maxFrac - 1) + '1' : s}`;
}

/** Valor exacto, sin truncar (para tooltip). */
export function exactUnits(base: string | null | undefined, decimals: number): string {
  return formatUnits(base, decimals, decimals);
}

export const shortHex = (h?: string | null, n = 6) => (h ? `${h.slice(0, n + 2)}…${h.slice(-4)}` : '—');

export function ago(iso: string, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000));
  if (s < 60) return `${s} s`;
  if (s < 3600) return `${Math.floor(s / 60)} min`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ${Math.floor((s % 3600) / 60)} min`;
  return `${Math.floor(s / 86400)} d`;
}
