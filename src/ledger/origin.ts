// Regla de origen (fase 3 del portal): solo credenciales del cliente originan operaciones que mueven su saldo.
// Con ORIGIN_RULE=enforce, la consola de 856 y las API_KEYS globales no originan retiros, transferencias internas
// ni altas de lista blanca de clientes: solo consultan, validan, autorizan o rechazan.
// Única excepción prevista: el gestor delegado con delegación o mandato vigente (fase 6) — punto de extensión abajo.
import type { FastifyRequest } from 'fastify';
import { config } from '../config.js';
import { HttpError } from '../idempotency.js';

export type OriginOp = 'withdrawal' | 'internal_transfer' | 'whitelist' | 'obligation';

/** Fase 6: devolverá true cuando el operador sea gestor asignado a una delegación vigente que cubra la operación. */
async function delegateAllows(_req: FastifyRequest, _op: OriginOp, _clientId: string | null): Promise<boolean> {
  return false;
}

export async function assertConsoleMayOriginate(req: FastifyRequest, op: OriginOp, clientId: string | null) {
  if (config.ORIGIN_RULE !== 'enforce') return;
  if (await delegateAllows(req, op, clientId)) return;
  throw new HttpError(403, 'Solo el cliente origina esta operación (portal o su llave de API); la consola solo valida, autoriza o rechaza', 'origin_not_client');
}
