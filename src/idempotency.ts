import { createHash } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { pool } from './db.js';

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const STALE_MS = 60_000; // una petición "en curso" más vieja que esto se considera abandonada

// Estable: mismo JSON con claves en otro orden produce la misma huella
const canonical = (v: unknown): string =>
  Array.isArray(v) ? `[${v.map(canonical).join(',')}]`
  : v && typeof v === 'object' ? `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`).join(',')}}`
  : JSON.stringify(v);

export class HttpError extends Error {
  constructor(public statusCode: number, message: string, public code = 'http_error') { super(message); }
}

/**
 * Ejecuta `handler` una sola vez por (API key, ruta, Idempotency-Key).
 * Reintentos con el mismo cuerpo reciben la respuesta original; con otro cuerpo, 422.
 */
export async function idempotent<T>(
  req: FastifyRequest, reply: FastifyReply,
  handler: (scopedKey: string) => Promise<{ status: number; body: T }>,
) {
  const key = req.headers['idempotency-key'];
  if (typeof key !== 'string' || key.length < 8 || key.length > 200) {
    throw new HttpError(400, 'Header Idempotency-Key requerido (8–200 caracteres)', 'idempotency_key_required');
  }
  const scope = sha(`${req.headers['x-api-key'] ?? ''}|${req.method}|${req.routeOptions.url}`).slice(0, 32);
  const requestHash = sha(canonical({ params: req.params, body: req.body ?? null }));

  const ins = await pool.query(
    `INSERT INTO idempotency_keys (scope, key, request_hash) VALUES ($1,$2,$3)
     ON CONFLICT (scope, key) DO NOTHING RETURNING key`,
    [scope, key, requestHash],
  );

  if (!ins.rowCount) {
    const { rows: [row] } = await pool.query(
      'SELECT request_hash, status_code, response_body, created_at FROM idempotency_keys WHERE scope = $1 AND key = $2',
      [scope, key],
    );
    if (row.request_hash !== requestHash) {
      throw new HttpError(422, 'Idempotency-Key ya usada con un cuerpo distinto', 'idempotency_key_reused');
    }
    if (row.status_code != null) {
      reply.header('idempotent-replayed', 'true');
      return reply.code(row.status_code).send(row.response_body);
    }
    if (Date.now() - new Date(row.created_at).getTime() < STALE_MS) {
      throw new HttpError(409, 'Petición con esta Idempotency-Key aún en proceso', 'idempotency_in_progress');
    }
    // Abandonada: se re-ejecuta (la operación contable es idempotente por sí misma)
  }

  try {
    const { status, body } = await handler(`${scope}:${key}`);
    await pool.query(
      `UPDATE idempotency_keys SET status_code = $3, response_body = $4, completed_at = now()
        WHERE scope = $1 AND key = $2`,
      [scope, key, status, JSON.stringify(body)],
    );
    return reply.code(status).send(body);
  } catch (e) {
    const status = (e as { statusCode?: number }).statusCode;
    if (status && status >= 400 && status < 500) {
      // Errores de negocio son definitivos: se guardan para responder igual en el reintento
      const body = { error: (e as Error).message, code: (e as { code?: string }).code };
      await pool.query(
        `UPDATE idempotency_keys SET status_code = $3, response_body = $4, completed_at = now() WHERE scope = $1 AND key = $2`,
        [scope, key, status, JSON.stringify(body)],
      );
    } else {
      // Error técnico: liberar la llave para permitir reintento
      await pool.query('DELETE FROM idempotency_keys WHERE scope = $1 AND key = $2', [scope, key]);
    }
    throw e;
  }
}
