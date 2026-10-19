// Cliente HTTP de la consola: solo cookie de sesión (httpOnly). La x-api-key nunca existe en el navegador.
export class ApiError extends Error {
  constructor(public status: number, message: string, public code?: string) { super(message); }
}

export async function api<T>(path: string, init: RequestInit & { json?: unknown } = {}): Promise<T> {
  const { json, headers, ...rest } = init;
  const method = (rest.method ?? 'GET').toUpperCase();
  const res = await fetch(`/v1${path}`, {
    credentials: 'same-origin',
    ...rest,
    method,
    headers: {
      accept: 'application/json',
      ...(json !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(method !== 'GET' ? { 'x-856-console': '1' } : {}),
      ...headers,
    },
    body: json !== undefined ? JSON.stringify(json) : rest.body,
  });
  const body = res.headers.get('content-type')?.includes('application/json') ? await res.json() : null;
  if (!res.ok) {
    const err = new ApiError(res.status, body?.error ?? `Error ${res.status}`, body?.code);
    if (res.status === 401 && path !== '/auth/login') window.dispatchEvent(new CustomEvent('c856:unauthorized'));
    throw err;
  }
  return body as T;
}

export type Role = 'lectura' | 'ejecutivo' | 'tesorero';
export interface Operator { id: string; email: string; name: string; role: Role; totp_enabled: boolean }

export interface Asset { id: string; symbol: string; decimals: number; kind: string; network: string }
export interface ReconBalance {
  asset_id: string; hot_wallet?: string; deposit_addresses?: string; onchain_total: string | null;
  ledger_custody: string; difference: string | null; error?: string;
}
export interface InflightWithdrawal {
  id: string; client_id: string; client_name: string; asset_id: string; amount: string;
  status: 'reserved' | 'signed' | 'broadcast'; to_address: string; tx_hash: string | null; nonce: string | null;
  confirmations: number; attempts: number; last_error: string | null; created_at: string; updated_at: string;
  approval_status?: string;
}
export interface Summary {
  generated_at: string;
  health: {
    status: 'ok' | 'degraded'; db: 'ok' | 'down';
    chain: { status: 'ok' | 'down'; network: string; chain_id?: number; block?: string; error?: string | null };
    worker_enabled: boolean; sweep_enabled: boolean; confirmations: number; signer: string | null;
  };
  explorer: string | null;
  assets: Asset[];
  reconciliation: { status: 'ok' | 'not_configured' | 'error'; address?: string; deposit_addresses?: number; balances: ReconBalance[]; note?: string; error?: string };
  gas: { asset_id: string | null; decimals: number; address: string | null; balance_wei: string | null; threshold_wei: string; low: boolean | null };
  withdrawals_in_flight: { total: number; by_status: Record<string, number>; items: InflightWithdrawal[] };
  deposits_pending: number;
  sweeps_open: number;
  clients_by_status: Record<string, number>;
  approvals_pending?: { withdrawals: number; netting_runs: number; exits_overdue?: number; deposits_held?: number; asset_requests?: number };
  obligations_pending?: { total: number; expiring_24h: number };
  networks?: NetworkStatus[];
  dual_approval?: 'off' | 'console' | 'all';
  origin_rule?: 'off' | 'enforce';
  environment?: 'production' | 'sandbox';
  treasurers?: { active_with_2fa: number; single: boolean };
}

// ───────────── Fase 2: clientes, cuentas, asientos ─────────────
export type ClientStatus = 'pending_kyb' | 'active' | 'suspended' | 'closed';
export type ClientKind = 'corporate' | 'fund' | 'fintech' | 'individual';
export interface ClientRow {
  id: string; external_id: string | null; name: string; kind: ClientKind; status: ClientStatus;
  metadata: Record<string, unknown>; created_at: string; accounts_count: number;
}
export interface Account {
  id: string; code: string; client_id: string | null; asset_id: string; type: string; normal_side: 'debit' | 'credit';
  allow_negative: boolean; balance: string; version: string; name: string; created_at: string;
}
export interface ClientDetail extends Omit<ClientRow, 'accounts_count'> {
  status_reason: string | null; status_changed_at: string | null;
  metadata: Record<string, unknown> & { simulation_status?: 'passed' | 'pending' };
  accounts: Account[]; allowed_transitions: ClientStatus[];
}
export interface Wallet {
  id: string; client_id: string | null; chain: string; network: string; address: string;
  purpose: 'master_hot' | 'master_cold' | 'deposit' | 'withdrawal_whitelist';
  derivation_index: number | null; webhook_registered: boolean; label: string | null; active: boolean; created_at: string;
  wl_status?: 'pending_approval' | 'active' | 'removed' | null; active_from?: string | null;
}
export interface PostingLine {
  account_id: string; account_code: string; client_id?: string | null; asset_id: string;
  direction: 'debit' | 'credit'; amount: string; balance_after: string;
}
export interface EntryRow {
  id: string; kind: string; description: string | null; external_ref: string | null;
  metadata: Record<string, unknown>; created_at: string; postings?: PostingLine[];
}
export interface AccountPosting {
  id: string; entry_id: string; direction: 'debit' | 'credit'; amount: string; balance_after: string;
  created_at: string; kind: string; external_ref: string | null;
}

/** Llave de idempotencia por intento de formulario: un doble clic reenvía la misma. */
export const newIdemKey = () => `console-${crypto.randomUUID()}`;

// ───────────── Fase 3: retiros, depósitos y barridos ─────────────
export type WithdrawalStatus = 'reserved' | 'signed' | 'broadcast' | 'confirmed' | 'failed' | 'cancelled';
export interface WithdrawalRow {
  id: string; client_id: string; client_name: string; asset_id: string; to_address: string; amount: string;
  status: WithdrawalStatus; tx_hash: string | null; nonce: string | null; confirmations: number; attempts: number;
  last_error: string | null; created_at: string; updated_at: string;
  approval_status: ApprovalStatus; requested_by: string | null;
}
export type ApprovalStatus = 'not_required' | 'pending' | 'approved' | 'rejected';
export interface WithdrawalDetail extends WithdrawalRow {
  account_id: string; from_address: string | null; block_number: string | null; gas_used: string | null; gas_cost_wei: string | null;
  reserve_entry_id: string | null; settle_entry_id: string | null; reversal_entry_id: string | null;
  metadata: Record<string, unknown>; required_confirmations: number;
  requested_by_operator: string | null; approved_by: string | null; approved_at: string | null;
  rejected_by: string | null; rejected_reason: string | null;
  broadcast_at: string | null; bumps: number; attempts_log: TxAttempt[];
}
/** Cada envío de la misma transacción (original y reemplazos por gas bump). */
export interface TxAttempt {
  tx_hash: string; max_fee_per_gas: string; max_priority_fee_per_gas: string; reason: 'original' | 'bump' | 'manual';
  requested_by: string | null; sent_at: string | null; error: string | null; created_at: string;
}
export type DepositStatus = 'pending' | 'held' | 'credited' | 'orphaned';
export interface DepositRow {
  id: string; tx_hash: string; log_index: number; wallet_id: string; client_id: string; client_name: string; asset_id: string;
  from_address: string | null; to_address: string; amount: string; block_number: string; confirmations: number;
  status: DepositStatus; entry_id: string | null; source: 'api' | 'webhook'; created_at: string; credited_at: string | null;
  network?: string; held_reason?: string | null; released_by?: string | null; released_at?: string | null;
}
export type SweepStatus = 'signed' | 'broadcast' | 'confirmed' | 'failed';
export interface SweepRow {
  id: string; wallet_id: string; client_id: string | null; client_name: string | null; kind: 'gas_topup' | 'sweep_token' | 'sweep_native';
  asset_id: string; amount: string; from_address: string; to_address: string; nonce: string; tx_hash: string; status: SweepStatus;
  block_number: string | null; gas_cost_wei: string | null; last_error: string | null; created_at: string; updated_at: string;
}

// ───────────── Fase 4: compensación ─────────────
export type ObligationStatus = 'pending_acceptance' | 'open' | 'settled' | 'cancelled' | 'rejected' | 'expired';
export interface ObligationRow {
  id: string; debtor_id: string; debtor_name: string; debtor_status: ClientStatus;
  creditor_id: string; creditor_name: string; creditor_status: ClientStatus;
  asset_id: string; amount: string; due_at: string | null; external_ref: string | null; status: ObligationStatus;
  netting_run_id: string | null; metadata: Record<string, unknown>; created_at: string; settled_at: string | null;
  cancel_reason: string | null; cancelled_at: string | null; cancelled_by: string | null;
  // Fase 4 del portal: aceptación por el deudor
  accept_due_at?: string | null; accepted_by?: string | null; accepted_at?: string | null;
  rejected_by?: string | null; rejected_at?: string | null; rejected_reason?: string | null; origin_kind?: string | null; created_by?: string | null;
}
export interface NettingPosition {
  client_id: string; client_name: string; client_status: ClientStatus;
  receivable: string; payable: string; net: string; available: string; shortfall: string; blocked: boolean;
}
export interface NettingPreview {
  obligations: number; obligation_ids: string[]; participants: number;
  gross_amount: string; net_amount: string; savings_bps: number;
  positions: NettingPosition[]; blocked_clients: string[]; can_settle: boolean;
}
export type RunStatus = 'pending_approval' | 'settled' | 'rejected';
export interface NettingRunRow {
  id: string; asset_id: string; status: RunStatus; cutoff: string | null; obligations: number; participants: number;
  gross_amount: string; net_amount: string; savings_bps: number; entry_id: string | null; created_by: string | null; created_at: string;
  approved_by: string | null; rejected_by: string | null; rejected_reason: string | null; decided_at: string | null; last_error: string | null;
}
export interface NettingRunDetail extends Omit<NettingRunRow, 'obligations'> {
  requested_by_operator: string | null; expected_net_amount: string | null;
  positions: { client_id: string; client_name: string; receivable: string; payable: string; net: string; shortfall?: string; blocked?: boolean }[];
  obligations: { id: string; debtor_id: string; debtor_name: string; creditor_id: string; creditor_name: string; amount: string; external_ref: string | null; due_at: string | null; status?: ObligationStatus }[];
  preview: (NettingPreview & { all_open: boolean; net_matches: boolean }) | null;
}

// ───────────── Fase 5: aprobaciones, bitácora, 2FA ─────────────
export interface PendingWithdrawal {
  id: string; client_id: string; client_name: string; client_status: ClientStatus; asset_id: string; amount: string; to_address: string;
  requested_by: string | null; requested_by_operator: string | null; created_at: string;
  // Fase 3 (salida originada por el cliente); null en retiros anteriores
  simulation_id: string | null; scope_hash: string | null; origin_kind: string | null; origin_label: string | null;
  validation_due_at: string | null; overdue: boolean;
  client_approver: string | null; client_approved_at: string | null; wl_label: string | null; wl_active_from: string | null;
  sim_available: string | null; sim_balance_after: string | null; sim_payable_open: string | null; sim_fee: string | null; simulated_at: string | null;
}
export interface PendingRun {
  id: string; asset_id: string; obligations: number; participants: number; gross_amount: string; net_amount: string;
  expected_net_amount: string; savings_bps: number; created_by: string | null; requested_by_operator: string | null; last_error: string | null; created_at: string;
}
export interface Approvals {
  policy: { dual_approval: 'off' | 'console' | 'all'; require_2fa: boolean; origin_rule?: 'off' | 'enforce' };
  withdrawals: PendingWithdrawal[]; netting_runs: PendingRun[];
}
export interface AuditEntry {
  id: string; at: string; operator_id: string | null; actor: string; action: string; target: string | null;
  status: number | null; ip: string | null; metadata: Record<string, unknown>;
}
export interface OperatorRow {
  id: string; email: string; name: string; role: Role; active: boolean; totp_enabled: boolean; totp_enabled_at: string | null;
  last_login_at: string | null; locked_until: string | null; created_at: string;
  deactivated_at?: string | null; deactivated_by?: string | null; active_sessions?: number;
}

// ───────────── Administración de operadores ─────────────
export interface OperatorInvite { id: string; email: string; role: Role; created_at: string; expires_at: string; created_by: string }
export interface PortalAlert { client_id: string; name: string; admins: number; users: number }

/** Mensajes en español para los códigos de error de administración de operadores. */
const OP_ERRORS: Record<string, string> = {
  self_change: 'No puede cambiar su propio rol o estado: pídalo a otro tesorero.',
  self_reset: 'No puede restablecer su propio 2FA: pídalo a otro tesorero.',
  last_treasurer: 'Debe quedar al menos un tesorero activo con 2FA: active el 2FA de otro tesorero antes de hacer este cambio.',
  email_in_use: 'Ese correo ya pertenece a un operador activo.',
  operator_inactive: 'Ese correo pertenece a un operador desactivado: reactívelo desde la tabla en lugar de invitarlo.',
  invite_pending: 'Ya hay una invitación vigente para ese correo: revóquela para emitir otra.',
  invite_not_pending: 'La invitación ya fue usada o revocada.',
  bad_code: 'Código 2FA incorrecto o ya usado: espere al siguiente código de su app.',
  totp_required: 'Necesita activar su 2FA (Seguridad) para administrar operadores.',
  invalid_invite: 'La invitación no es válida: ya se usó, se revocó o venció. Pida un enlace nuevo.',
  weak_password: 'La contraseña requiere al menos 12 caracteres.',
};
export function opError(e: unknown): Error | null {
  if (!e) return null;
  if (e instanceof ApiError && e.code && OP_ERRORS[e.code]) return new ApiError(e.status, OP_ERRORS[e.code], e.code);
  if (e instanceof ApiError && e.status === 429) return new ApiError(429, 'Demasiados intentos. Espere un minuto.', 'rate_limited');
  return e instanceof Error ? e : new Error(String(e));
}

// ───────────── Multi-red (ola 1) y activos habilitados por cliente ─────────────
export interface NetworkInfo { id: string; label: string; primary: boolean; chain_id: number | null; healthy: boolean; error: string | null; confirmations: number; explorer: string | null; webhook: boolean }
export interface NetworkStatus extends NetworkInfo {
  status: 'ok' | 'down' | 'disabled'; block: string | null;
  gas: { asset_id: string | null; decimals: number; balance_wei: string | null; threshold_wei: string; low: boolean | null;
    ledger_custody?: string | null; unregistered_wei?: string | null; stuck_sweeps?: number; stuck_withdrawals?: number };
  reconciliation: { status: string; balances: ReconBalance[] };
}
export type ClientAssetStatus = 'enabled' | 'exit_only' | 'disabled';
export interface ClientAssetRow {
  asset_id: string; symbol: string; network: string; kind: string; decimals: number; status: ClientAssetStatus;
  updated_by: string | null; updated_at: string | null; balance: string; pending_request: string | null; network_enabled: boolean;
}
export interface AssetRequest {
  id: string; client_id: string; client_name: string; asset_id: string; symbol: string; network: string;
  action: 'enable' | 'exit_only' | 'disable'; reason: string; status: 'pending' | 'approved' | 'rejected';
  requested_by: string; requested_by_operator: string | null; decided_by: string | null; decided_at: string | null; decision_note: string | null; created_at: string;
}
export const ASSET_STATUS: Record<ClientAssetStatus, { label: string; variant: 'success' | 'warning' | 'outline' }> = {
  enabled: { label: 'Habilitado', variant: 'success' }, exit_only: { label: 'Solo salida', variant: 'warning' }, disabled: { label: 'No habilitado', variant: 'outline' },
};
export const REQUEST_ACTION: Record<AssetRequest['action'], string> = { enable: 'Habilitar', exit_only: 'Pasar a solo salida', disable: 'Deshabilitar' };
