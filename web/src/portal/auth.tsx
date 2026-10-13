import { createContext, useContext, useEffect, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError, papi, type ClientRole, type PortalMe } from './api';

interface Ctx { me: PortalMe | null; loading: boolean; refresh: () => Promise<unknown>; logout: () => Promise<void>; isAdmin: boolean; role: ClientRole | null }
const C = createContext<Ctx | null>(null);

export function PortalAuthProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const me = useQuery({
    queryKey: ['portal-me'], staleTime: 60_000, retry: false,
    queryFn: () => papi<PortalMe>('/me').catch((e) => { if (e instanceof ApiError && e.status === 401) return null; throw e; }),
  });
  useEffect(() => {
    // Solo si había sesión: sin sesión (p. ej. aceptando una invitación) no hay nada que limpiar y se cortarían consultas en curso
    const out = () => { if (!qc.getQueryData(['portal-me'])) return; qc.setQueryData(['portal-me'], null); qc.removeQueries({ predicate: (q) => q.queryKey[0] !== 'portal-me' }); };
    const enroll = () => qc.invalidateQueries({ queryKey: ['portal-me'] });
    window.addEventListener('c856p:unauthorized', out);
    window.addEventListener('c856p:enroll', enroll);
    return () => { window.removeEventListener('c856p:unauthorized', out); window.removeEventListener('c856p:enroll', enroll); };
  }, [qc]);
  const data = me.data ?? null;
  return (
    <C.Provider value={{
      me: data, loading: me.isPending, role: data?.user.role ?? null, isAdmin: data?.user.role === 'admin',
      refresh: () => qc.invalidateQueries({ queryKey: ['portal-me'] }),
      logout: async () => { await papi('/auth/logout', { method: 'POST', json: {} }).catch(() => null); qc.clear(); qc.setQueryData(['portal-me'], null); },
    }}>{children}</C.Provider>
  );
}
export function usePortal() {
  const c = useContext(C);
  if (!c) throw new Error('usePortal fuera del proveedor');
  return c;
}
