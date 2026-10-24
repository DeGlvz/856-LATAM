// Regla de origen (fase 3 del portal): las credenciales del cliente originan operaciones sobre su saldo.
// Con ORIGIN_RULE=enforce, las API_KEYS globales no originan retiros, transferencias internas ni altas de lista blanca.
// Los operadores de consola pueden ingresar retiros por instrucción, pero la lista blanca sigue siendo del cliente.
// Única excepción prevista: el gestor delegado con delegación o mandato vigente (fase 6) — punto de extensión abajo.
import type { FastifyRequest } from 'fastify';
import { config } from '../config.js';
import { HttpError } from '../idempotency.js';

export type OriginOp = 'withdrawal' | 'internal_transfer' | 'whitelist' | 'obligation';

/** Mandato de un branch_case: solo vale si el cliente firmó y hay referencia de mandato. */
export interface BranchMandate { caseId: string; mandateRef: string | null; clientSignedAt: Date | string | null }
export interface OriginContext { branchMandate?: BranchMandate }

const mandateAllows = (op: OriginOp, m?: BranchMandate) =>
  (op === 'internal_transfer' || op === 'obligation') && !!m && !!m.caseId && !!m.clientSignedAt && !!m.mandateRef?.trim();

/** Fase 6: devolverá true cuando el operador sea gestor asignado a una delegación vigente que cubra la operación. */
async function delegateAllows(_req: FastifyRequest | null, op: OriginOp, _clientId: string | null, ctx?: OriginContext): Promise<boolean> {
  return mandateAllows(op, ctx?.branchMandate);
}

export async function assertConsoleMayOriginate(req: FastifyRequest, op: OriginOp, clientId: string | null, ctx?: OriginContext) {
  if (config.ORIGIN_RULE !== 'enforce') return;
  if (await delegateAllows(req, op, clientId, ctx)) return;
  throw new HttpError(403, 'Solo el cliente origina esta operación (portal o su llave de API); la consola solo valida, autoriza o rechaza', 'origin_not_client');
}

/** Dentro del apply de un branch_case: la consola origina solo con mandato firmado por el cliente. La regla global no cambia. */
export async function assertBranchMayOriginate(op: OriginOp, clientId: string, mandate: BranchMandate) {
  if (config.ORIGIN_RULE !== 'enforce') return;
  if (await delegateAllows(null, op, clientId, { branchMandate: mandate })) return;
  throw new HttpError(403, 'Sin mandato firmado por el cliente (firma y referencia de mandato) la consola no origina esta operación', 'origin_mandate_required');
}
