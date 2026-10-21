// Solicitudes de acceso de la página pública (856latam.com/#solicitar-acceso).
//   • POST /v1/public/access-requests: público, con límite por IP y campo trampa contra bots.
//   • GET  /v1/console/access-requests y POST /v1/console/access-requests/:id/status: ejecutivo o tesorero.
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { pool } from '../db.js';
import { audit, hasRole } from '../auth/operators.js';
import { HttpError } from '../idempotency.js';

export const PUBLIC_ACCESS_REQUEST_PATH = '/v1/public/access-requests';
const VOLUMES = ['lt_100k', '100k_1m', '1m_10m', 'gt_10m'] as const;
const STATUSES = ['new', 'contacted', 'closed'] as const;

const Body = z.object({
  full_name: z.string().trim().min(2).max(120),
  company: z.string().trim().min(2).max(160),
  email: z.string().trim().toLowerCase().email().max(200),
  country: z.string().trim().min(2).max(80),
  volume: z.enum(VOLUMES),
  message: z.string().trim().max(2000).optional(),
  website: z.string().max(200).optional(), // campo trampa: invisible para personas
});

const parse = <T>(schema: z.ZodType<T>, v: unknown): T => {
  const r = schema.safeParse(v ?? {});
  if (!r.success) throw new HttpError(400, r.error.issues.map((i) => `${i.path.join('.') || 'cuerpo'}: ${i.message}`).join('; '), 'validation_error');
  return r.data;
};

/** Datos de contacto: solo ejecutivo o tesorero (lectura no los ve). */
function requireEjecutivo(req: FastifyRequest) {
  const p = req.principal;
  if (p?.kind !== 'operator' || !hasRole(p.operator.role, 'ejecutivo')) throw new HttpError(403, 'Requiere rol ejecutivo', 'forbidden');
  return p;
}

export async function accessRequestRoutes(app: FastifyInstance) {
  app.post('/public/access-requests', { config: { rateLimit: { max: 5, timeWindow: '1 hour' } } }, async (req, reply) => {
    const b = parse(Body, req.body);
    // Un bot que llena el campo trampa recibe la misma respuesta, pero no se guarda nada
    if (b.website) return reply.code(201).send({ ok: true });
    await pool.query(
      `INSERT INTO access_requests (full_name, company, email, country, volume, message, ip, user_agent)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [b.full_name, b.company, b.email, b.country, b.volume, b.message || null, req.ip, String(req.headers['user-agent'] ?? '').slice(0, 300)],
    );
    return reply.code(201).send({ ok: true });
  });

  app.get('/console/access-requests', async (req) => {
    requireEjecutivo(req);
    const q = parse(z.object({ status: z.enum(STATUSES).optional() }), req.query);
    const { rows } = await pool.query(
      `SELECT id, full_name, company, email, country, volume, message, status, handled_by, handled_at, created_at
         FROM access_requests WHERE ($1::text IS NULL OR status = $1) ORDER BY created_at DESC LIMIT 500`,
      [q.status ?? null],
    );
    const { rows: [c] } = await pool.query(`SELECT count(*) FILTER (WHERE status = 'new')::int AS new FROM access_requests`);
    return { items: rows, counts: { new: c.new } };
  });

  app.post<{ Params: { id: string } }>('/console/access-requests/:id/status', async (req) => {
    const p = requireEjecutivo(req);
    const id = parse(z.string().uuid(), req.params.id);
    const b = parse(z.object({ status: z.enum(STATUSES) }), req.body);
    const { rows: [row] } = await pool.query(
      `UPDATE access_requests SET status = $2, handled_by = $3, handled_at = now() WHERE id = $1
       RETURNING id, status, handled_by, handled_at`,
      [id, b.status, p.operator.email],
    );
    if (!row) throw new HttpError(404, 'Solicitud no encontrada', 'not_found');
    await audit({ operator_id: p.operator.id, actor: p.operator.email, action: 'access_request_status', target: id, status: 200, ip: req.ip, metadata: { status: b.status } });
    return row;
  });
}
