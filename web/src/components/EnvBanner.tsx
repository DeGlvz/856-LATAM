// Fase M1: distintivo fijo de ambiente. En el sandbox (pruebas de clientes) se muestra en todas las pantallas,
// incluso antes del login, para que nadie confunda ese ambiente con dinero real. Producción no muestra franja.
import { useQuery } from '@tanstack/react-query';
import { FlaskConical, ShieldAlert } from 'lucide-react';

export interface Meta { environment: 'production' | 'sandbox'; setup_required: boolean }

export function useMeta() {
  return useQuery({
    queryKey: ['meta'],
    queryFn: () => fetch('/v1/meta', { credentials: 'same-origin' }).then((r) => (r.ok ? (r.json() as Promise<Meta>) : null)),
    staleTime: 60_000,
    refetchInterval: (q) => (q.state.data?.setup_required ? 10_000 : false),
  });
}

export function EnvBanner() {
  const { data } = useMeta();
  if (!data) return null;
  return (
    <>
      {data.environment === 'sandbox' && (
        <div role="note" data-testid="env-banner" className="flex items-center justify-center gap-2 bg-amber-400 px-3 py-1 text-xs font-semibold tracking-wide text-amber-950">
          <FlaskConical className="size-3.5" />PRUEBAS · ambiente de pruebas: los saldos y movimientos no son dinero real
        </div>
      )}
      {data.setup_required && (
        <div role="alert" data-testid="setup-banner" className="flex items-center justify-center gap-2 bg-destructive px-3 py-1.5 text-xs font-medium text-white">
          <ShieldAlert className="size-3.5" />Modo de alta: un tesorero debe activar su 2FA (Seguridad) antes de que el servicio opere.
        </div>
      )}
    </>
  );
}

/** Insignia fija en la cabecera (siempre visible al desplazarse). */
export function EnvBadge() {
  const { data } = useMeta();
  if (data?.environment !== 'sandbox') return null;
  return <span data-testid="env-badge" className="rounded bg-amber-400 px-2 py-0.5 text-[11px] font-bold tracking-wider text-amber-950">PRUEBAS</span>;
}
