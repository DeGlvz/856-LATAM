import { useQuery } from '@tanstack/react-query';
import { api, type Summary, type Asset, type NetworkInfo } from './api';

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

/** Fase 3: con ORIGIN_RULE=enforce la consola no origina retiros ni altas de lista blanca de clientes. */
export function useConsoleOriginates() {
  const q = useQuery({ queryKey: ['summary'], queryFn: () => api<Summary>('/summary'), staleTime: 60_000 });
  return q.data ? q.data.origin_rule !== 'enforce' : false;
}

/** Multi-red: redes encendidas (etiqueta, explorador y confirmaciones por red). */
export function useNetworks() {
  const q = useQuery({ queryKey: ['networks'], queryFn: () => api<{ networks: NetworkInfo[] }>('/networks').then((r) => r.networks), staleTime: 5 * 60_000 });
  const byId = (id: string) => q.data?.find((n) => n.id === id);
  return { ...q, networks: q.data ?? [], byId, label: (id: string) => byId(id)?.label ?? id, explorer: (id: string) => byId(id)?.explorer ?? 'https://sepolia.etherscan.io' };
}
