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

export type Role = 'lectura' | 'operador' | 'tesorero';
export interface Operator { id: string; email: string; name: string; role: Role }

export interface Asset { id: string; symbol: string; decimals: number; kind: string; network: string }
export interface ReconBalance {
  asset_id: string; hot_wallet?: string; deposit_addresses?: string; onchain_total: string | null;
  ledger_custody: string; difference: string | null; error?: string;
}
export interface InflightWithdrawal {
  id: string; client_id: string; client_name: string; asset_id: string; amount: string;
  status: 'reserved' | 'signed' | 'broadcast'; to_address: string; tx_hash: string | null; nonce: string | null;
  confirmations: number; attempts: number; last_error: string | null; created_at: string; updated_at: string;
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
  accounts: Account[]; allowed_transitions: ClientStatus[];
}
export interface Wallet {
  id: string; client_id: string | null; chain: string; network: string; address: string;
  purpose: 'master_hot' | 'master_cold' | 'deposit' | 'withdrawal_whitelist';
  derivation_index: number | null; webhook_registered: boolean; label: string | null; active: boolean; created_at: string;
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
}
export interface WithdrawalDetail extends WithdrawalRow {
  account_id: string; from_address: string | null; block_number: string | null; gas_used: string | null; gas_cost_wei: string | null;
  reserve_entry_id: string | null; settle_entry_id: string | null; reversal_entry_id: string | null;
  metadata: Record<string, unknown>; required_confirmations: number;
}
export type DepositStatus = 'pending' | 'credited' | 'orphaned';
export interface DepositRow {
  id: string; tx_hash: string; log_index: number; wallet_id: string; client_id: string; client_name: string; asset_id: string;
  from_address: string | null; to_address: string; amount: string; block_number: string; confirmations: number;
  status: DepositStatus; entry_id: string | null; source: 'api' | 'webhook'; created_at: string; credited_at: string | null;
}
export type SweepStatus = 'signed' | 'broadcast' | 'confirmed' | 'failed';
export interface SweepRow {
  id: string; wallet_id: string; client_id: string | null; client_name: string | null; kind: 'gas_topup' | 'sweep_token' | 'sweep_native';
  asset_id: string; amount: string; from_address: string; to_address: string; nonce: string; tx_hash: string; status: SweepStatus;
  block_number: string | null; gas_cost_wei: string | null; last_error: string | null; created_at: string; updated_at: string;
}
