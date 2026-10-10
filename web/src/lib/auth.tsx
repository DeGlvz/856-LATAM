import { createContext, useContext, useEffect, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError, type Operator, type Role } from './api';

interface AuthCtx {
  operator: Operator | null;
  loading: boolean;
  login: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  can: (role: Role) => boolean;
}
const Ctx = createContext<AuthCtx | null>(null);
const RANK: Record<Role, number> = { lectura: 0, operador: 1, tesorero: 2 };

export function AuthProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const me = useQuery({
    queryKey: ['me'],
    queryFn: () => api<{ operator: Operator }>('/auth/me').then((r) => r.operator).catch((e) => {
      if (e instanceof ApiError && e.status === 401) return null;
      throw e;
    }),
    staleTime: 60_000,
    retry: false,
  });

  // Cualquier 401 (sesión vencida o revocada) regresa al login y limpia datos en memoria
  useEffect(() => {
    const onUnauth = () => { qc.setQueryData(['me'], null); qc.removeQueries({ predicate: (q) => q.queryKey[0] !== 'me' }); };
    window.addEventListener('c856:unauthorized', onUnauth);
    return () => window.removeEventListener('c856:unauthorized', onUnauth);
  }, [qc]);

  const loginM = useMutation({
    mutationFn: (v: { email: string; password: string }) => api<{ operator: Operator }>('/auth/login', { method: 'POST', json: v }),
    onSuccess: (r) => qc.setQueryData(['me'], r.operator),
  });
  const logoutM = useMutation({
    mutationFn: () => api('/auth/logout', { method: 'POST', json: {} }).catch(() => null),
    onSettled: () => { qc.clear(); qc.setQueryData(['me'], null); },
  });

  const operator = me.data ?? null;
  return (
    <Ctx.Provider value={{
      operator, loading: me.isPending,
      login: async (email, password) => { await loginM.mutateAsync({ email, password }); },
      logout: async () => { await logoutM.mutateAsync(); },
      can: (r) => !!operator && RANK[operator.role] >= RANK[r],
    }}>
      {children}
    </Ctx.Provider>
  );
}

export function useAuth() {
  const c = useContext(Ctx);
  if (!c) throw new Error('useAuth fuera de AuthProvider');
  return c;
}
