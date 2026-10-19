// Portal de clientes — fase 4: obligaciones y compensación. Se registra dentro de portalRoutes (hereda autenticación,
// anti-CSRF, gate de 2FA y bitácora). El acreedor registra; el deudor acepta o rechaza; solo lo aceptado se compensa.
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { HttpError } from '../idempotency.js';
import * as O from '../portal/obligations.js';
import { audit } from '../auth/operators.js';
import { rollbackOnly, simulationFingerprint, simulationResult, type SimulationIssue } from '../simulation.js';

const parse = <S extends z.ZodTypeAny>(s: S, v: unknown): z.infer<S> => {
  const r = s.safeParse(v);
  if (!r.success) throw new HttpError(400, r.error.issues.map((i) => `${i.path.join('.') || 'cuerpo'}: ${i.message}`).join('; '), 'validation_error');
  return r.data;
};
const uuid = z.string().uuid();
const amount = z.string().regex(/^[1-9]\d{0,77}$/, 'entero positivo en unidades base');
const assetId = z.string().regex(/^[A-Z0-9-]{3,40}$/, 'activo inválido');
const reason = z.string().trim().min(5, 'Indique el motivo (mín. 5 caracteres)').max(500);
const page = { limit: z.coerce.number().int().min(1).max(200).default(50), cursor: z.string().max(300).optional() };

// Llaves: lectura con permiso read; registrar, aceptar, rechazar, cancelar y cargar con permiso trade (solo Ed25519)
export const OBLIGATION_KEY_READ = [
  'GET /v1/portal/counterparty', 'GET /v1/portal/counterparties/:code', 'GET /v1/portal/obligations', 'GET /v1/portal/obligations/:id',
  'GET /v1/portal/netting/positions', 'GET /v1/portal/netting/runs', 'GET /v1/portal/netting/runs/:id',
];
export const OBLIGATION_KEY_WRITE = [
  'POST /v1/portal/obligations', 'POST /v1/portal/obligations/:id/accept', 'POST /v1/portal/obligations/:id/reject',
  'POST /v1/portal/obligations/:id/cancel', 'POST /v1/portal/obligations/import',
  'POST /v1/portal/obligations/import/:id/commit', 'POST /v1/portal/obligations/import/:id/discard',
];

export async function portalObligationRoutes(app: FastifyInstance) {
  // ── Contrapartes ──
  app.get('/counterparty', async (req) => O.myCounterpartyCode(req.portal!.clientId));
  app.get<{ Params: { code: string } }>('/counterparties/:code', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } },
    async (req) => O.lookupCounterparty(req.portal!.clientId, req.params.code));

  // ── Obligaciones ──
  app.get('/obligations', async (req) => {
    const q = parse(z.object({
      role: z.enum(['creditor', 'debtor']).optional(),
      status: z.enum(['pending_acceptance', 'open', 'settled', 'cancelled', 'rejected', 'expired']).optional(),
      asset_id: assetId.optional(), ...page,
    }), req.query);
    return O.listObligations(req.portal!.clientId, q, req.portal!.kind !== 'assist');
  });
  app.get<{ Params: { id: string } }>('/obligations/:id', async (req) =>
    O.getObligation(req.portal!.clientId, parse(uuid, req.params.id), req.portal!.kind !== 'assist'));
  app.post('/obligations', async (req, reply) => {
    const b = parse(z.object({
      counterparty_code: z.string().trim().min(5).max(20), asset_id: assetId, amount,
      external_ref: z.string().trim().min(1).max(200).optional(), due_at: z.string().datetime({ offset: true }).optional(),
    }), req.body);
    return reply.code(201).send(await O.createObligation(req.portal!, b, req.ip));
  });
  app.post<{ Params: { id: string } }>('/obligations/:id/accept', async (req) => {
    const b = parse(z.object({ code: z.string().regex(/^\d{6}$/, 'código de 6 dígitos').optional() }), req.body ?? {});
    return O.acceptObligation(req.portal!, parse(uuid, req.params.id), b.code);
  });
  app.post<{ Params: { id: string } }>('/obligations/:id/reject', async (req) =>
    O.rejectObligation(req.portal!, parse(uuid, req.params.id), parse(z.object({ reason }), req.body ?? {}).reason));
  app.post<{ Params: { id: string } }>('/obligations/:id/cancel', async (req) =>
    O.cancelObligation(req.portal!, parse(uuid, req.params.id), parse(z.object({ reason }), req.body ?? {}).reason));

  // ── Carga masiva: validar (no registra nada) → confirmar o descartar ──
  app.post('/obligations/import', {
    bodyLimit: 4 * 1024 * 1024,
    preHandler: async (req, reply) => {
      if (req.headers['x-856-simulate'] !== 'true') return;
      const p = req.portal!;
      if (p.kind !== 'client_key' || p.key.kind !== 'ed25519') {
        return reply.code(422).send({ errors: [{
          fila: 1, campo: 'firma', motivo: 'La simulación requiere una petición firmada con una llave Ed25519 del cliente',
        }] satisfies SimulationIssue[] });
      }
      const body = z.object({ filename: z.string().max(200).optional(), csv: z.string().min(1).max(4 * 1024 * 1024) }).safeParse(req.body);
      if (!body.success) {
        return reply.code(422).send({ errors: body.error.issues.map((i) => ({
          fila: 1, campo: i.path.join('.') || 'payload', motivo: i.message,
        })) });
      }
      const fingerprint = simulationFingerprint({
        route: 'POST /v1/portal/obligations/import', client_id: p.clientId, payload: body.data,
      });
      let result: Awaited<ReturnType<typeof O.validateImport>>;
      try {
        result = await rollbackOnly((c) => O.validateImport(p, body.data.filename, body.data.csv, c, false));
      } catch (e) {
        if (e instanceof HttpError) {
          return reply.code(422).send({ errors: [{
            fila: 1, campo: e.code === 'bad_header' || e.code === 'empty_file' ? 'encabezado' : 'payload', motivo: e.message,
          }] satisfies SimulationIssue[] });
        }
        throw e;
      }
      if (!result.total_rows || result.valid_rows !== result.total_rows || result.error_rows) {
        const errors = result.errors.map((e) => ({ fila: e.row, campo: e.field, motivo: e.message }));
        if (!errors.length) errors.push({ fila: 1, campo: 'filas', motivo: 'La plantilla debe contener al menos una fila válida' });
        return reply.code(422).send({ errors });
      }
      await audit({
        actor: `llave:${p.key.prefix}`, action: 'template_simulation_passed', client_id: p.clientId, status: 200,
        ip: req.ip, metadata: { fingerprint, rows: result.total_rows, provider_calls: 0 },
      });
      return reply.code(200).send(simulationResult(fingerprint, {
        status: 'validated', client_id: p.clientId, total_rows: result.total_rows,
        valid_rows: result.valid_rows, error_rows: 0, preview: result.preview,
      }));
    },
  }, async (req, reply) => {
    const b = parse(z.object({ filename: z.string().max(200).optional(), csv: z.string().min(1).max(4 * 1024 * 1024) }), req.body);
    return reply.code(201).send(await O.validateImport(req.portal!, b.filename, b.csv));
  });
  app.post<{ Params: { id: string } }>('/obligations/import/:id/commit', async (req) =>
    O.commitImport(req.portal!, parse(uuid, req.params.id), req.ip));
  app.post<{ Params: { id: string } }>('/obligations/import/:id/discard', async (req) =>
    O.discardImport(req.portal!, parse(uuid, req.params.id)));

  // ── Compensación (solo lo propio) ──
  app.get('/netting/positions', async (req) => {
    const q = parse(z.object({ asset_id: assetId.optional() }), req.query);
    return O.myPositions(req.portal!.clientId, q.asset_id);
  });
  app.get('/netting/runs', async (req) => O.myRuns(req.portal!.clientId, parse(z.object({ asset_id: assetId.optional(), ...page }), req.query)));
  app.get<{ Params: { id: string } }>('/netting/runs/:id', async (req) => O.myRun(req.portal!.clientId, parse(uuid, req.params.id)));
}
