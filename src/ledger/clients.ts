import { isAddress } from 'viem';
import { pool, tx } from '../db.js';
import { LedgerError } from './service.js';

export type ClientStatus = 'pending_kyb' | 'active' | 'suspended' | 'closed';

// Transiciones permitidas del ciclo de vida. 'closed' es definitivo.
const TRANSITIONS: Record<ClientStatus, ClientStatus[]> = {
  pending_kyb: ['active', 'closed'],
  active: ['suspended', 'closed'],
  suspended: ['active', 'closed'],
  closed: [],
};
export const allowedTransitions = (s: ClientStatus) => TRANSITIONS[s];

export async function updateClient(id: string, i: {
  name?: string; external_id?: string | null; metadata?: Record<string, unknown>; status?: ClientStatus; reason?: string;
}) {
  return tx(async (c) => {
    const { rows: [cl] } = await c.query('SELECT * FROM clients WHERE id = $1 FOR UPDATE', [id]);
    if (!cl) throw new LedgerError(404, 'Cliente no encontrado', 'not_found');
    if (cl.status === 'closed') throw new LedgerError(409, 'Cliente cerrado: no admite cambios', 'client_closed');

    if (i.status && i.status !== cl.status) {
      if (!TRANSITIONS[cl.status as ClientStatus].includes(i.status)) {
        throw new LedgerError(409, `Transición no permitida: ${cl.status} → ${i.status}`, 'invalid_transition');
      }
      if (['suspended', 'closed'].includes(i.status) && (i.reason?.trim().length ?? 0) < 5) {
        throw new LedgerError(400, 'Indique el motivo (mín. 5 caracteres) para suspender o cerrar', 'reason_required');
      }
      if (i.status === 'closed') {
        // Cerrar exige no deberle nada al cliente ni tener operaciones abiertas
        const { rows: [chk] } = await c.query(
          `SELECT
             (SELECT count(*) FROM accounts WHERE client_id = $1 AND balance <> 0) AS balances,
             (SELECT count(*) FROM withdrawals WHERE client_id = $1 AND status IN ('reserved','signed','broadcast')) AS withdrawals,
             (SELECT count(*) FROM deposits WHERE client_id = $1 AND status = 'pending') AS deposits,
             (SELECT count(*) FROM fiat_accounts WHERE client_id = $1 AND mode = 'per_client' AND status <> 'closed') AS fiat_accounts,
             (SELECT count(*) FROM fiat_deposits d JOIN fiat_accounts a ON a.id = d.fiat_account_id
                WHERE a.client_id = $1 AND a.mode = 'per_client' AND d.status IN ('received','minted','reconciled','review')) AS fiat_deposits,
             (SELECT count(*) FROM obligations WHERE (debtor_id = $1 OR creditor_id = $1) AND status = 'open') AS obligations`, [id]);
        const open = Object.entries(chk).filter(([, n]) => n !== '0').map(([k, n]) => `${k}: ${n}`);
        if (open.length) throw new LedgerError(409, `No se puede cerrar: ${open.join(', ')}`, 'client_not_empty');
      }
    }

    const { rows: [u] } = await c.query(
      `UPDATE clients SET
          name        = COALESCE($2, name),
          external_id = CASE WHEN $3::boolean THEN $4 ELSE external_id END,
          metadata    = COALESCE($5, metadata),
          status      = COALESCE($6, status),
          status_reason     = CASE WHEN $6::text IS NOT NULL AND $6 <> status THEN $7 ELSE status_reason END,
          status_changed_at = CASE WHEN $6::text IS NOT NULL AND $6 <> status THEN now() ELSE status_changed_at END
        WHERE id = $1 RETURNING *`,
      [id, i.name?.trim() ?? null, i.external_id !== undefined, i.external_id ?? null, i.metadata ?? null,
        i.status ?? null, i.reason?.trim() || null]);
    return u;
  });
}

export async function setWalletActive(id: string, active: boolean) {
  const { rows: [w] } = await pool.query(
    `UPDATE wallets SET active = $2 WHERE id = $1 AND purpose IN ('withdrawal_whitelist','deposit') RETURNING *`, [id, active]);
  if (!w) throw new LedgerError(404, 'Wallet no encontrada (solo lista blanca o depósito)', 'not_found');
  return w;
}

export function assertAddress(chain: string, address: string) {
  if (chain === 'ethereum' && !isAddress(address, { strict: false })) {
    throw new LedgerError(400, 'Dirección Ethereum inválida', 'invalid_address');
  }
}

export async function clientStatus(id: string): Promise<ClientStatus> {
  const { rows: [c] } = await pool.query('SELECT status FROM clients WHERE id = $1', [id]);
  if (!c) throw new LedgerError(404, 'Cliente no encontrado', 'not_found');
  return c.status;
}
