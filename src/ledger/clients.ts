import { isAddress } from 'viem';
import { pool, tx } from '../db.js';
import { isEnabled } from '../chain/networks.js';
import { LedgerError } from './service.js';

export type ClientStatus = 'pending_kyb' | 'active' | 'suspended' | 'closed';
export type ClientRetirementSummary = {
  open_reasons: string[];
  has_financial_history: boolean;
  has_audit_history: boolean;
  can_hard_delete: boolean;
};

// Transiciones permitidas del ciclo de vida. 'closed' es definitivo.
const TRANSITIONS: Record<ClientStatus, ClientStatus[]> = {
  pending_kyb: ['active', 'closed'],
  active: ['suspended', 'closed'],
  suspended: ['active', 'closed'],
  closed: [],
};
export const allowedTransitions = (s: ClientStatus) => TRANSITIONS[s];

export function summarizeClientRetirement(v: Record<string, unknown>): ClientRetirementSummary {
  const n = (k: string) => Number(v[k] ?? 0);
  const reasons: string[] = [];
  if (n('balance_accounts') > 0 || n('balance_total') > 0) reasons.push('saldo');
  if (n('obligations') > 0) reasons.push('obligaciones');
  if (n('withdrawals') > 0) reasons.push('retiros');
  if (n('deposits') > 0) reasons.push('depósitos');
  if (n('fiat_accounts') > 0) reasons.push('cuentas fiat');
  if (n('fiat_deposits') > 0) reasons.push('depósitos fiat');
  if (n('fiat_intents') > 0) reasons.push('avisos fiat');
  const hasFinancialHistory =
    n('accounts') > 0 || n('wallets') > 0 || n('obligations_history') > 0 || n('withdrawals_history') > 0 || n('deposits_history') > 0
    || n('fiat_accounts') > 0 || n('fiat_deposits') > 0 || n('fiat_intents') > 0 || n('balance_total') > 0;
  const hasAuditHistory = n('audit_entries') > 0;
  return {
    open_reasons: reasons,
    has_financial_history: hasFinancialHistory,
    has_audit_history: hasAuditHistory,
    can_hard_delete: reasons.length === 0 && !hasFinancialHistory && !hasAuditHistory,
  };
}

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
             (SELECT count(*) FROM accounts WHERE client_id = $1 AND balance <> 0) AS balance_accounts,
             (SELECT COALESCE(SUM(balance), 0)::text FROM accounts WHERE client_id = $1) AS balance_total,
             (SELECT count(*) FROM withdrawals WHERE client_id = $1 AND status IN ('reserved','signed','broadcast')) AS withdrawals,
             (SELECT count(*) FROM deposits WHERE client_id = $1 AND status = 'pending') AS deposits,
             (SELECT count(*) FROM fiat_accounts WHERE client_id = $1 AND mode = 'per_client' AND status <> 'closed') AS fiat_accounts,
             (SELECT count(*) FROM fiat_deposits d JOIN fiat_accounts a ON a.id = d.fiat_account_id
                WHERE a.client_id = $1 AND a.mode = 'per_client' AND d.status IN ('received','minted','reconciled','review')) AS fiat_deposits,
             (SELECT count(*) FROM fiat_payment_intents WHERE client_id = $1 AND status = 'open') AS fiat_intents,
             (SELECT count(*) FROM obligations WHERE (debtor_id = $1 OR creditor_id = $1) AND status IN ('pending_acceptance','open')) AS obligations,
             (SELECT count(*) FROM accounts WHERE client_id = $1) AS accounts,
             (SELECT count(*) FROM wallets WHERE client_id = $1) AS wallets,
             (SELECT count(*) FROM audit_log WHERE client_id = $1) AS audit_entries,
             (SELECT count(*) FROM withdrawals WHERE client_id = $1) AS withdrawals_history,
             (SELECT count(*) FROM deposits WHERE client_id = $1) AS deposits_history,
             (SELECT count(*) FROM obligations WHERE debtor_id = $1 OR creditor_id = $1) AS obligations_history`, [id]);
        const summary = summarizeClientRetirement(chk as Record<string, unknown>);
        if (summary.open_reasons.length) {
          throw new LedgerError(409, `No se puede cerrar: ${summary.open_reasons.join(', ')}`, 'client_not_empty');
        }
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

export async function retireClient(id: string, opts: { reason: string; by?: string }) {
  return tx(async (c) => {
    const { rows: [cl] } = await c.query('SELECT * FROM clients WHERE id = $1 FOR UPDATE', [id]);
    if (!cl) throw new LedgerError(404, 'Cliente no encontrado', 'not_found');
    const { rows: [chk] } = await c.query(
      `SELECT
         (SELECT count(*) FROM accounts WHERE client_id = $1 AND balance <> 0) AS balance_accounts,
         (SELECT COALESCE(SUM(balance), 0)::text FROM accounts WHERE client_id = $1) AS balance_total,
         (SELECT count(*) FROM obligations WHERE (debtor_id = $1 OR creditor_id = $1) AND status IN ('pending_acceptance','open')) AS obligations,
         (SELECT count(*) FROM withdrawals WHERE client_id = $1 AND status IN ('reserved','signed','broadcast')) AS withdrawals,
         (SELECT count(*) FROM deposits WHERE client_id = $1 AND status = 'pending') AS deposits,
         (SELECT count(*) FROM fiat_accounts WHERE client_id = $1 AND mode = 'per_client' AND status <> 'closed') AS fiat_accounts,
         (SELECT count(*) FROM fiat_deposits d JOIN fiat_accounts a ON a.id = d.fiat_account_id
            WHERE a.client_id = $1 AND a.mode = 'per_client' AND d.status IN ('received','minted','reconciled','review')) AS fiat_deposits,
         (SELECT count(*) FROM fiat_payment_intents WHERE client_id = $1 AND status = 'open') AS fiat_intents,
         (SELECT count(*) FROM accounts WHERE client_id = $1) AS accounts,
         (SELECT count(*) FROM wallets WHERE client_id = $1) AS wallets,
         (SELECT count(*) FROM audit_log WHERE client_id = $1) AS audit_entries,
         (SELECT count(*) FROM obligations WHERE debtor_id = $1 OR creditor_id = $1) AS obligations_history,
         (SELECT count(*) FROM withdrawals WHERE client_id = $1) AS withdrawals_history,
         (SELECT count(*) FROM deposits WHERE client_id = $1) AS deposits_history`, [id]);
    const summary = summarizeClientRetirement(chk as Record<string, unknown>);
    if (summary.open_reasons.length) {
      throw new LedgerError(409,
        `No se puede retirar el cliente: hay operaciones financieras abiertas (${summary.open_reasons.join(', ')}).`,
        'client_has_open_financial_operations');
    }

    const reason = opts.reason.trim();
    if (!reason || reason.length < 5) throw new LedgerError(400, 'Indique el motivo (mín. 5 caracteres) para retirar el cliente', 'reason_required');

    const metadata = {
      ...(cl.metadata && typeof cl.metadata === 'object' ? cl.metadata : {}),
      retired: true,
      retired_at: new Date().toISOString(),
      retired_by: opts.by ?? 'console',
      retired_reason: reason,
    };

    if (!summary.can_hard_delete) {
      const { rows: [u] } = await c.query(
        `UPDATE clients SET
            name = 'Cliente retirado',
            external_id = NULL,
            status = 'closed',
            metadata = $2,
            status_reason = $3,
            status_changed_at = now(),
            retired_at = now(),
            retired_by = $4
          WHERE id = $1 RETURNING id, name, status, external_id`,
        [id, JSON.stringify(metadata), reason, opts.by ?? 'console']);
      return { action: 'anonymized', client: u };
    }

    await c.query('DELETE FROM client_api_nonces WHERE key_id IN (SELECT id FROM client_api_keys WHERE client_id = $1)', [id]);
    await c.query('DELETE FROM client_key_challenges WHERE user_id IN (SELECT id FROM client_users WHERE client_id = $1)', [id]);
    await c.query('DELETE FROM client_recovery_codes WHERE user_id IN (SELECT id FROM client_users WHERE client_id = $1)', [id]);
    await c.query('DELETE FROM client_mfa_challenges WHERE user_id IN (SELECT id FROM client_users WHERE client_id = $1)', [id]);
    await c.query('DELETE FROM client_sessions WHERE user_id IN (SELECT id FROM client_users WHERE client_id = $1)', [id]);
    await c.query('DELETE FROM client_sessions WHERE client_id = $1', [id]);
    await c.query('DELETE FROM client_api_keys WHERE client_id = $1', [id]);
    await c.query('DELETE FROM client_invites WHERE client_id = $1', [id]);
    await c.query('DELETE FROM client_users WHERE client_id = $1', [id]);
    await c.query('DELETE FROM wallets WHERE client_id = $1', [id]);
    await c.query('DELETE FROM accounts WHERE client_id = $1', [id]);
    await c.query('DELETE FROM clients WHERE id = $1', [id]);
    return { action: 'deleted', client_id: id };
  });
}

export async function setWalletActive(id: string, active: boolean) {
  return tx(async (c) => {
    const { rows: [wallet] } = await c.query(
      `SELECT id, client_id, network, purpose, active, archived_at FROM wallets
        WHERE id = $1 AND purpose IN ('withdrawal_whitelist','deposit') FOR UPDATE`, [id]);
    if (!wallet) throw new LedgerError(404, 'Wallet no encontrada (solo lista blanca o depósito)', 'not_found');
    if (wallet.purpose === 'deposit' && !active && wallet.active && !wallet.archived_at && isEnabled(wallet.network)) {
      const { rows: [receivable] } = await c.query(
        `SELECT 1 FROM client_assets ca JOIN assets s ON s.id = ca.asset_id
          WHERE ca.client_id = $1 AND s.network = $2 AND s.active AND ca.status = 'enabled' LIMIT 1`, [wallet.client_id, wallet.network]);
      if (receivable) {
        const { rows: [other] } = await c.query(
          `SELECT 1 FROM wallets WHERE client_id = $1 AND network = $2 AND purpose = 'deposit'
             AND active AND archived_at IS NULL AND id <> $3 LIMIT 1`, [wallet.client_id, wallet.network, id]);
        if (!other) throw new LedgerError(409, 'Debe quedar al menos una dirección visible para recibir en esta red', 'last_visible_deposit_address');
      }
    }
    const { rows: [updated] } = await c.query('UPDATE wallets SET active = $2 WHERE id = $1 RETURNING *', [id, active]);
    return updated;
  });
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
