// Conciliación con Openfort (opcional, OPENFORT_ENABLED=false por defecto). Solo observa: valida la firma, guarda el evento
// de forma idempotente y lo cruza por hash con barridos, retiros e intentos de reemplazo. Nunca asienta en el libro ni firma:
// la cadena sigue siendo la fuente de verdad y la custodia/2FA no cambian.
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { pool } from '../db.js';

export const SIGNATURE_HEADER = 'openfort-signature';

/** HMAC-SHA256 (hex) del cuerpo crudo con la clave whsec_… del dashboard; comparación en tiempo constante. */
export function verifySignature(raw: string, received: unknown, secret: string): boolean {
  if (!secret || typeof received !== 'string' || !received) return false;
  const expected = createHmac('sha256', secret).update(raw, 'utf8').digest('hex');
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(received.trim().toLowerCase(), 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

export type OpenfortEvent = { type: string; date: number | null; data: unknown };

export function parseEvent(raw: string): OpenfortEvent | null {
  let o: unknown;
  try { o = JSON.parse(raw); } catch { return null; }
  if (!o || typeof o !== 'object') return null;
  const e = o as { type?: unknown; date?: unknown; data?: unknown };
  if (typeof e.type !== 'string' || !e.type) return null;
  return { type: e.type, date: typeof e.date === 'number' ? e.date : null, data: e.data ?? null };
}

/** Hashes de transacción (0x + 64 hex) presentes en cualquier parte del payload, sin repetir. */
export function extractTxHashes(data: unknown): string[] {
  const out = new Set<string>();
  const walk = (v: unknown, depth: number) => {
    if (depth > 6 || v == null) return;
    if (typeof v === 'string') { if (/^0x[0-9a-fA-F]{64}$/.test(v)) out.add(v.toLowerCase()); return; }
    if (Array.isArray(v)) { v.slice(0, 50).forEach((x) => walk(x, depth + 1)); return; }
    if (typeof v === 'object') Object.values(v as object).slice(0, 100).forEach((x) => walk(x, depth + 1));
  };
  walk(data, 0);
  return [...out];
}

type Matched = { kind: 'sweep' | 'withdrawal'; id: string } | null;

async function matchByHash(hashes: string[]): Promise<Matched> {
  if (!hashes.length) return null;
  const { rows: [att] } = await pool.query(
    `SELECT kind, ref_id FROM tx_attempts WHERE tx_hash = ANY($1::text[]) LIMIT 1`, [hashes]);
  if (att) return { kind: att.kind, id: att.ref_id };
  const { rows: [s] } = await pool.query(`SELECT id FROM sweeps WHERE tx_hash = ANY($1::text[]) LIMIT 1`, [hashes]);
  if (s) return { kind: 'sweep', id: s.id };
  const { rows: [w] } = await pool.query(`SELECT id FROM withdrawals WHERE tx_hash = ANY($1::text[]) LIMIT 1`, [hashes]);
  return w ? { kind: 'withdrawal', id: w.id } : null;
}

/** Guarda el evento (idempotente por huella del cuerpo) y lo concilia por hash. */
export async function ingest(raw: string, evt: OpenfortEvent) {
  const digest = createHash('sha256').update(raw, 'utf8').digest('hex');
  const hashes = extractTxHashes(evt.data);
  const m = await matchByHash(hashes);
  const { rows } = await pool.query(
    `INSERT INTO openfort_events (digest, type, event_date, tx_hashes, matched_kind, matched_id, payload)
     VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb) ON CONFLICT (digest) DO NOTHING RETURNING id`,
    [digest, evt.type, evt.date, hashes, m?.kind ?? null, m?.id ?? null, JSON.stringify(evt.data)]);
  return { duplicate: rows.length === 0, matched: m, hashes: hashes.length };
}
