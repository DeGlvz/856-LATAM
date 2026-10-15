// Cliente HTTP del portal: cookie de sesión propia (httpOnly) + header anti-CSRF. Nunca guarda secretos en el navegador.
import { ApiError } from '@/lib/api';
export { ApiError };

export async function papi<T>(path: string, init: RequestInit & { json?: unknown } = {}): Promise<T> {
  const { json, headers, ...rest } = init;
  const method = (rest.method ?? 'GET').toUpperCase();
  const res = await fetch(`/v1/portal${path}`, {
    credentials: 'same-origin', ...rest, method,
    headers: {
      accept: 'application/json',
      ...(json !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(method !== 'GET' ? { 'x-856-portal': '1' } : {}),
      ...headers,
    },
    body: json !== undefined ? JSON.stringify(json) : rest.body,
  });
  const body = res.headers.get('content-type')?.includes('application/json') ? await res.json() : null;
  if (!res.ok) {
    if (res.status === 401 && !path.startsWith('/auth/login') && !path.startsWith('/invites')) window.dispatchEvent(new CustomEvent('c856p:unauthorized'));
    if (res.status === 403 && body?.code === 'totp_enrollment_required') window.dispatchEvent(new CustomEvent('c856p:enroll'));
    throw new ApiError(res.status, body?.error ?? `Error ${res.status}`, body?.code);
  }
  return body as T;
}

export type ClientRole = 'viewer' | 'operator' | 'approver' | 'admin';
export interface PortalUser { id: string; client_id: string; email: string; name: string; role: ClientRole; totp_enabled: boolean }
export interface PortalMe {
  kind: 'user'; user: PortalUser; client: { id: string; name: string; kind: string; status: string }; totp_enrollment_required: boolean;
}
export interface UserRow {
  id: string; email: string; name: string; role: ClientRole; active: boolean; totp_enabled: boolean;
  last_login_at: string | null; created_at: string; recovery_codes_left: number;
}
export interface InviteRow { id: string; email: string; role: ClientRole; created_by: string; expires_at: string; created_at: string; link?: string }
export interface KeyRow {
  id: string; name: string; kind: 'ed25519' | 'read_token'; prefix: string; permissions: string[]; ip_allowlist: string[];
  expires_at: string; rotated_from: string | null; last_used_at: string | null; last_used_ip: string | null;
  revoked_at: string | null; locked_until: string | null; created_at: string; created_by: string;
}

export const ROLE_LABEL: Record<ClientRole, string> = { viewer: 'Consulta', operator: 'Operador', approver: 'Aprobador', admin: 'Administrador' };
export const ROLE_HELP: Record<ClientRole, string> = {
  viewer: 'Solo consulta saldos y movimientos.',
  operator: 'Prepara operaciones (retiros, obligaciones).',
  approver: 'Aprueba operaciones del cliente. 2FA obligatorio.',
  admin: 'Administra usuarios y llaves de API. 2FA obligatorio.',
};

// ───────────── Fase 2: saldos, movimientos, estados de cuenta y depósitos ─────────────
export interface AssetView { asset_id: string; symbol: string; decimals: number; network: string }
export interface BalanceRow extends AssetView { available: string; reserved: string; payable: string; receivable: string; total: string; asset_status?: MyAssetStatus | null; explorer?: string | null }
export interface Line {
  id: string; created_at: string; asset_id: string; kind: string; direction: 'credit' | 'debit'; amount: string; balance_after: string;
  reference: string | null; reference_type: 'withdrawal' | 'netting_run' | 'tx_hash' | null; label: string;
}
export interface ActivityLine extends Line { symbol: string; decimals: number }
export interface EntriesPage { asset: AssetView; balance: string; entries: Line[]; next_cursor: string | null }
export interface Statement {
  asset: AssetView; period: string; timezone: 'UTC'; period_start: string; period_end: string;
  opening_balance: string; credits: string; debits: string; closing_balance: string; current_balance: string; entries: Line[];
}
export interface DepositAddress { id: string; address: string; network: string; derivation_index: number | null; created_at: string; active: boolean; uri: string; network_label?: string; explorer?: string | null }
export interface DepositRow {
  id: string; tx_hash: string; log_index: number; asset_id: string; symbol: string; decimals: number; amount: string;
  from_address: string; to_address: string; status: 'pending' | 'held' | 'credited' | 'orphaned'; confirmations: number | null; network?: string; network_label?: string; explorer?: string | null;
  required_confirmations: number; block_number: string | null; created_at: string; credited_at: string | null;
}
export interface Notice { code: string; severity: 'info' | 'warning' | 'critical'; message: string; data?: Record<string, unknown> }

/** Explorador de bloques por red (el portal no consulta la configuración interna de 856). */
// Multi-red: explorador y nombre por red (el servidor manda el explorador configurado cuando lo tiene).
export const NETS: Record<string, { label: string; explorer: string; native?: string }> = {
  'eth-sepolia': { label: 'Ethereum Sepolia', explorer: 'https://sepolia.etherscan.io' },
  'base-sepolia': { label: 'Base Sepolia', explorer: 'https://sepolia.basescan.org' },
  'arb-sepolia': { label: 'Arbitrum Sepolia', explorer: 'https://sepolia.arbiscan.io' },
  'polygon-amoy': { label: 'Polygon Amoy', explorer: 'https://amoy.polygonscan.com', native: 'POL' },
  'bnb-testnet': { label: 'BNB Smart Chain Testnet', explorer: 'https://testnet.bscscan.com', native: 'tBNB' },
  'opt-sepolia': { label: 'OP Sepolia', explorer: 'https://sepolia-optimism.etherscan.io' },
  'avax-fuji': { label: 'Avalanche Fuji', explorer: 'https://testnet.snowtrace.io', native: 'AVAX' },
  'eth-mainnet': { label: 'Ethereum', explorer: 'https://etherscan.io' },
};
export const explorerFor = (network: string, fromServer?: string | null) => fromServer ?? NETS[network]?.explorer ?? 'https://sepolia.etherscan.io';
export const netLabel = (network: string) => NETS[network]?.label ?? network;
export const nativeOf = (network: string) => NETS[network]?.native ?? 'ETH';
export type MyAssetStatus = 'enabled' | 'exit_only';
export interface MyAsset { asset_id: string; symbol: string; network: string; network_label: string; kind: string; decimals: number; status: MyAssetStatus; network_enabled: boolean; network_primary?: boolean; sweep_min?: string | null }

/** Descarga autenticada (cookie de sesión) de un CSV del portal; nunca pone la sesión en la URL. */
export async function downloadPortal(path: string, fallbackName: string) {
  const res = await fetch(`/v1/portal${path}`, { credentials: 'same-origin', headers: { accept: 'text/csv' } });
  if (!res.ok) {
    const body = res.headers.get('content-type')?.includes('application/json') ? await res.json() : null;
    throw new ApiError(res.status, body?.error ?? `Error ${res.status}`, body?.code);
  }
  const name = /filename="([^"]+)"/.exec(res.headers.get('content-disposition') ?? '')?.[1] ?? fallbackName;
  const a = document.createElement('a');
  a.href = URL.createObjectURL(await res.blob());
  a.download = name; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

// ───────────── Fase 3: lista blanca y salidas ─────────────
export type WlState = 'pending_approval' | 'cooling' | 'active' | 'removed';
export interface WlEntry {
  id: string; address: string; network: string; label: string | null; state: WlState;
  requested_at: string; approved_at: string | null; active_from: string | null; removed_at: string | null; requested_by_me: boolean;
}
export interface Simulation {
  id: string; asset_id: string; symbol: string; decimals: number; network: string; whitelist_id: string; to_address: string;
  amount: string; fee: string; gas_estimate: string | null; gas_paid_by: '856'; available: string; balance_after: string;
  payable_open: string; obligations: { id: string; amount: string; due_at: string | null; external_ref: string | null }[];
  scope_hash: string; status: 'simulated' | 'submitted' | 'expired'; expires_at: string; created_at: string;
}
export type ExitState = 'client_approval' | 'validation' | 'authorized' | 'sent' | 'executed' | 'rejected' | 'cancelled' | 'failed';
export interface ExitRow {
  id: string; asset_id: string; symbol: string; decimals: number; network: string; to_address: string; amount: string; state: ExitState;
  tx_hash: string | null; confirmations: number | null; required_confirmations: number;
  origin: { kind: 'client_user' | 'client_key' | 'delegate'; user: string | null; user_id: string | null; key: string | null };
  client_approved_at: string | null; client_approver: string | null; authorized_at: string | null;
  authorizations: { required: number; given: number }; rejection_reason: string | null; validation_due_at: string | null;
  simulation_id: string; scope_hash: string; created_at: string; updated_at: string;
}
export interface ThresholdRow { asset_id: string; symbol: string; decimals: number; threshold: string; updated_at: string }

export const EXIT_STATE: Record<ExitState, { t: string; v: 'warning' | 'success' | 'destructive' | 'secondary' | 'outline' }> = {
  client_approval: { t: 'Aprobación interna', v: 'warning' },
  validation: { t: 'En validación 856', v: 'warning' },
  authorized: { t: 'Autorizada', v: 'secondary' },
  sent: { t: 'Enviada', v: 'secondary' },
  executed: { t: 'Ejecutada', v: 'success' },
  rejected: { t: 'Rechazada por 856', v: 'destructive' },
  cancelled: { t: 'Cancelada', v: 'outline' },
  failed: { t: 'Fallida', v: 'destructive' },
};
export const WL_STATE: Record<WlState, { t: string; v: 'warning' | 'success' | 'secondary' | 'outline' }> = {
  pending_approval: { t: 'Por aprobar', v: 'warning' },
  cooling: { t: 'En espera', v: 'secondary' },
  active: { t: 'Vigente', v: 'success' },
  removed: { t: 'Retirada', v: 'outline' },
};
/** Rango del rol del cliente para mostrar u ocultar acciones (el servidor vuelve a validarlo). */
export const roleAtLeast = (r: ClientRole | null | undefined, min: ClientRole) =>
  !!r && (['viewer', 'operator', 'approver', 'admin'] as const).indexOf(r) >= (['viewer', 'operator', 'approver', 'admin'] as const).indexOf(min);

// ───────────── Fase 4: obligaciones y compensación ─────────────
export type ObStatus = 'pending_acceptance' | 'open' | 'settled' | 'cancelled' | 'rejected' | 'expired';
export interface ObRow {
  id: string; role: 'creditor' | 'debtor'; counterparty: { name: string };
  asset_id: string; symbol: string; decimals: number; amount: string; external_ref: string | null; due_at: string | null;
  status: ObStatus; accept_due_at: string | null; accepted_at: string | null; rejected_at: string | null; rejected_reason: string | null;
  cancelled_at: string | null; cancel_reason: string | null; netting_run_id: string | null; settled_at: string | null; in_pending_run: boolean;
  origin: { kind: string; user: string | null; key: string | null } | null; import_id: string | null; created_at: string;
}
export interface ObImport {
  id: string; filename: string | null; status: 'validated' | 'committed' | 'discarded'; total_rows: number; valid_rows: number; error_rows: number;
  errors: { row: number; field: string; message: string }[];
  preview: { row: number; counterparty: string; asset_id: string; amount: string; external_ref: string | null; due_at: string | null }[];
  created?: number;
}
export interface MyPosition {
  asset_id: string; symbol: string; decimals: number; open_obligations: number; receivable: string; payable: string; net: string;
  gross: string; savings: string; savings_bps: number; available: string | null; shortfall: string;
}
export interface MyRunRow { id: string; asset_id: string; symbol: string; decimals: number; decided_at: string; created_at: string; receivable: string; payable: string; net: string }
export interface MyRun extends MyRunRow {
  entry: { id: string; direction: 'debit' | 'credit'; kind: 'abono' | 'cargo'; amount: string; balance_after: string; created_at: string } | null;
  obligations: ObRow[];
}
export const OB_STATE: Record<ObStatus, { t: string; v: 'warning' | 'success' | 'destructive' | 'secondary' | 'outline' }> = {
  pending_acceptance: { t: 'Por aceptar', v: 'warning' }, open: { t: 'Aceptada', v: 'secondary' }, settled: { t: 'Liquidada', v: 'success' },
  cancelled: { t: 'Cancelada', v: 'outline' }, rejected: { t: 'Rechazada', v: 'destructive' }, expired: { t: 'Vencida', v: 'outline' },
};
