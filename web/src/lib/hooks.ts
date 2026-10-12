import { useQuery } from '@tanstack/react-query';
import { api, type Asset } from './api';

export function useAssets() {
  const q = useQuery({ queryKey: ['assets'], queryFn: () => api<{ assets: (Asset & { active: boolean })[] }>('/assets').then((r) => r.assets), staleTime: 5 * 60_000 });
  const byId = (id: string): Asset => q.data?.find((a) => a.id === id) ?? { id, symbol: id, decimals: 0, kind: '', network: '' };
  return { ...q, assets: q.data ?? [], byId };
}

export const CLIENT_STATUS = {
  pending_kyb: { label: 'KYB pendiente', variant: 'warning' },
  active: { label: 'Activo', variant: 'success' },
  suspended: { label: 'Suspendido', variant: 'destructive' },
  closed: { label: 'Cerrado', variant: 'secondary' },
} as const;

export const CLIENT_KIND = { corporate: 'Corporativo', fund: 'Fondo', fintech: 'Fintech', individual: 'Persona' } as const;

export const ENTRY_KIND: Record<string, string> = {
  deposit: 'Depósito', withdrawal: 'Retiro', transfer: 'Transferencia', fee: 'Comisión',
  conversion: 'Conversión', netting: 'Compensación', adjustment: 'Ajuste',
};
