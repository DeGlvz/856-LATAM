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
export interface BalanceRow extends AssetView { available: string; reserved: string; payable: string; receivable: string; total: string }
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
export interface DepositAddress { id: string; address: string; network: string; derivation_index: number | null; created_at: string; active: boolean; uri: string }
export interface DepositRow {
  id: string; tx_hash: string; log_index: number; asset_id: string; symbol: string; decimals: number; amount: string;
  from_address: string; to_address: string; status: 'pending' | 'credited' | 'orphaned'; confirmations: number | null;
  required_confirmations: number; block_number: string | null; created_at: string; credited_at: string | null;
}
export interface Notice { code: string; severity: 'info' | 'warning' | 'critical'; message: string; data?: Record<string, unknown> }

/** Explorador de bloques por red (el portal no consulta la configuración interna de 856). */
export const explorerFor = (network: string) => (network === 'eth-mainnet' ? 'https://etherscan.io' : 'https://sepolia.etherscan.io');

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
