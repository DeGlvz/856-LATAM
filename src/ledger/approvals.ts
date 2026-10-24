// Doble aprobación ("cuatro ojos"): quien solicita no aprueba, y el aprobador confirma con su segundo factor.
import type { FastifyRequest } from 'fastify';
import { config } from '../config.js';
import { consumeTotp, type Operator } from '../auth/operators.js';
import { HttpError } from '../idempotency.js';

export interface Requester { by: string; operatorId: string | null; needsApproval: boolean }

/** Quién solicita y si la operación queda pendiente de aprobación según DUAL_APPROVAL. */
export function requester(req: FastifyRequest): Requester {
  const p = req.principal;
  const isOp = p?.kind === 'operator';
  return {
    by: isOp ? p.operator.email : `api:${p?.kind === 'api' ? p.keyId : '?'}`,
    operatorId: isOp ? p.operator.id : null,
    needsApproval: config.DUAL_APPROVAL === 'all' || (config.DUAL_APPROVAL === 'console' && isOp),
  };
}

/** Operador que decide (aprueba o rechaza). Las integraciones por API key no aprueban. */
export function decider(req: FastifyRequest): Operator {
  const p = req.principal;
  if (p?.kind !== 'operator') throw new HttpError(403, 'Solo un operador de la consola puede aprobar o rechazar', 'operator_only');
  return p.operator;
}

/**
 * Valida al aprobador: distinto del solicitante y, si APPROVAL_REQUIRE_2FA, con 2FA activo y un código TOTP vigente
 * (el código se consume: no sirve para una segunda aprobación).
 */
export async function assertApprover(op: Operator, requestedByOperator: string | null, code: string | undefined, require2fa: boolean = config.APPROVAL_REQUIRE_2FA) {
  if (requestedByOperator && requestedByOperator === op.id) {
    throw new HttpError(403, 'Doble aprobación: quien solicitó no puede aprobar', 'same_operator');
  }
  if (!require2fa) return;
  if (!op.totp_enabled) throw new HttpError(403, 'Para aprobar necesita el 2FA activo (Seguridad → Activar 2FA)', 'totp_required');
  if (!code || !/^\d{6}$/.test(code)) throw new HttpError(400, 'Código 2FA de 6 dígitos requerido para aprobar', 'totp_code_required');
  if ((await consumeTotp(op.id, code)) == null) throw new HttpError(422, 'Código 2FA incorrecto o ya usado', 'bad_code');
}
