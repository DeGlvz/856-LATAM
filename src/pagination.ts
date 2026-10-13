import { HttpError } from './idempotency.js';

// Cursor opaco para paginación por (created_at, id) descendente.
// created_at viaja como texto de PostgreSQL (microsegundos exactos), nunca como Date de JS.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const encodeCursor = (ts: string, id: string) => Buffer.from(JSON.stringify([ts, id])).toString('base64url');

export function decodeCursor(c?: string | null): [string, string] | null {
  if (!c) return null;
  try {
    const v = JSON.parse(Buffer.from(c, 'base64url').toString());
    if (Array.isArray(v) && typeof v[0] === 'string' && typeof v[1] === 'string' && UUID_RE.test(v[1])) return [v[0], v[1]];
  } catch { /* cae al error */ }
  throw new HttpError(400, 'Cursor inválido', 'invalid_cursor');
}

/** Corta la página (se pidió limit + 1) y calcula el siguiente cursor. Las filas deben traer `_ts` (created_at::text). */
export function page<T extends { _ts: string; id: string }>(rows: T[], limit: number) {
  const more = rows.length > limit;
  const items = rows.slice(0, limit);
  const last = items[items.length - 1];
  return {
    items: items.map(({ _ts, ...r }) => r as Omit<T, '_ts'>),
    next_cursor: more && last ? encodeCursor(last._ts, last.id) : null,
  };
}
