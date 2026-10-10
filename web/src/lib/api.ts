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
