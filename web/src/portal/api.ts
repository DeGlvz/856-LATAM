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
