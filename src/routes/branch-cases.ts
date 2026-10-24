// Consola: Terminal de Caja / Branch Case (bajo /v1/console/branch-cases).
// Ejecutivo y tesorero preparan, envían y cancelan; solo el tesorero aprueba (con 2FA y distinto de quien preparó) o rechaza.
// La firma del cliente aún no tiene ruta (portal en PR2): un caso con client_required queda en pending_client.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { audit, type Operator } from '../auth/operators.js';
import { HttpError, idempotent } from '../idempotency.js';
import * as B from '../ledger/branch-cases.js';
import { pool } from '../db.js';
import { rollbackOnly, simulationFingerprint, simulationResult } from '../simulation.js';

const uuid = z.string().uuid();
const parse = <S extends z.ZodTypeAny>(s: S, v: unknown): z.infer<S> => {
  const r = s.safeParse(v);
  if (!r.success) throw new HttpError(400, r.error.issues.map((i) => `${i.path.join('.') || 'cuerpo'}: ${i.message}`).join('; '), 'validation_error');
  return r.data;
};

const Reason = z.object({ reason: z.string().trim().min(5).max(500) });
const Approve = z.object({ code: z.string().regex(/^\d{6}$/, 'código de 6 dígitos').optional() });
const Query = z.object({
  status: z.enum(['draft', 'pending_client', 'pending_treasury', 'applied', 'rejected', 'cancelled']).optional(),
  client_id: uuid.optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().max(300).optional(),
});

function operator(req: FastifyRequest): Operator {
  const p = req.principal;
  if (p?.kind !== 'operator') throw new HttpError(403, 'Requiere sesión de ejecutivo o tesorero', 'session_required');
  return p.operator;
}

export async function branchCaseRoutes(app: FastifyInstance) {
  const P = '/console/branch-cases';
  const issues = (reply: FastifyReply, e: B.BranchValidationError) => reply.code(422).send({ errors: e.issues });
  /** Los errores de validación viajan como { errors: [{ linea, campo, motivo }] } */
  const guarded = async (reply: FastifyReply, work: () => Promise<unknown>) => {
    try { return await work(); } catch (e) {
      if (e instanceof B.BranchValidationError) return issues(reply, e);
      throw e;
    }
  };

  app.get(P, async (req) => {
    const q = parse(Query, req.query);
    return B.listCases({ status: q.status, clientId: q.client_id, limit: q.limit, cursor: q.cursor });
  });

  app.get<{ Params: { id: string } }>(`${P}/:id`, async (req) => B.getCase(parse(uuid, req.params.id)));

  app.post(P, {
    preHandler: async (req, reply) => {
      if (req.headers['x-856-simulate'] !== 'true') return;
      const op = operator(req);
      return guarded(reply, async () => {
        const v = await B.validateCase(pool, req.body);
        if (!v.ok) return reply.code(422).send({ errors: v.issues });
        // Se ejecuta el alta completa y se revierte: nada queda persistido
        const simulated = await rollbackOnly((c) => B.createCaseIn(c, op, req.body, null));
        const fingerprint = simulationFingerprint({ route: `POST ${P}`, payload: v.payload, client_required: v.clientRequired });
        return reply.code(200).send(simulationResult(fingerprint, {
          status: 'validated', kind: v.payload.kind, lines: v.payload.lines.length,
          payload_hash: simulated.payload_hash, client_required: v.clientRequired,
        }));
      });
    },
  }, async (req, reply) => {
    const op = operator(req);
    return idempotent<unknown>(req, reply, async (scoped) => {
      try {
        const created = await B.createCase(op, req.body, scoped);
        await audit({ operator_id: op.id, actor: `operador:${op.email}`, action: 'branch_case_created', target: created.id, ip: req.ip,
          client_id: created.client_id, status: 201, metadata: { kind: created.kind, lines: created.lines?.length, payload_hash: created.payload_hash, ...(created.verbal_reason ? { verbal: true, reason: created.verbal_reason } : {}) } });
        return { status: 201, body: created };
      } catch (e) {
        if (e instanceof B.BranchValidationError) return { status: 422, body: { errors: e.issues } };
        throw e;
      }
    });
  });

  app.post<{ Params: { id: string } }>(`${P}/:id/submit`, async (req, reply) => guarded(reply, async () => {
    const op = operator(req);
    const c = await B.submitCase(op, parse(uuid, req.params.id));
    await audit({ operator_id: op.id, actor: `operador:${op.email}`, action: 'branch_case_submitted', target: c.id, ip: req.ip, client_id: c.client_id, metadata: { status: c.status } });
    return c;
  }));

  app.post<{ Params: { id: string } }>(`${P}/:id/cancel`, async (req) => {
    const op = operator(req);
    const b = parse(Reason, req.body ?? {});
    const c = await B.cancelCase(op, parse(uuid, req.params.id), b.reason);
    await audit({ operator_id: op.id, actor: `operador:${op.email}`, action: 'branch_case_cancelled', target: c.id, ip: req.ip, client_id: c.client_id, metadata: { reason: b.reason } });
    return c;
  });

  app.post<{ Params: { id: string } }>(`${P}/:id/approve`, async (req, reply) => guarded(reply, async () => {
    const op = operator(req);
    const b = parse(Approve, req.body ?? {});
    const id = parse(uuid, req.params.id);
    const c = await B.approveCase(op, id, b.code);
    const meta = { payload_hash: c.payload_hash, created_by: c.created_by, entries: c.applied_entry_ids, obligations: c.applied_obligation_ids, transfers: c.applied_transfer_ids };
    await audit({ operator_id: op.id, actor: `operador:${op.email}`, action: 'branch_case_approved', target: c.id, ip: req.ip, client_id: c.client_id, metadata: { payload_hash: c.payload_hash, ...(c.verbal_reason ? { verbal: true, reason: c.verbal_reason } : {}) } });
    await audit({ operator_id: op.id, actor: `operador:${op.email}`, action: 'branch_case_applied', target: c.id, ip: req.ip, client_id: c.client_id, metadata: meta });
    return c;
  }));

  app.post<{ Params: { id: string } }>(`${P}/:id/reject`, async (req) => {
    const op = operator(req);
    const b = parse(Reason, req.body ?? {});
    const c = await B.rejectCase(op, parse(uuid, req.params.id), b.reason);
    await audit({ operator_id: op.id, actor: `operador:${op.email}`, action: 'branch_case_rejected', target: c.id, ip: req.ip, client_id: c.client_id, metadata: { reason: b.reason } });
    return c;
  });
}
