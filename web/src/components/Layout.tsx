import { useState } from 'react';
import { EnvBadge } from '@/components/EnvBanner';
import { NavLink, Outlet } from 'react-router';
import {
  ArrowLeftRight, Building2, Inbox, Euro, CheckCheck, FileClock, Gauge, KeyRound, Landmark, LogOut, Menu, Network, ShieldCheck, UsersRound, Wallet, X,
} from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { api, type Summary, type UsageOverview } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';

const NAV = [
  { to: '/', label: 'Tablero', icon: Gauge, phase: 1 },
  { to: '/clientes', label: 'Clientes y cuentas', icon: Building2, phase: 2 },
  { to: '/solicitudes', label: 'Solicitudes de acceso', icon: Inbox, phase: 2, ejecutivo: true },
  { to: '/movimientos', label: 'Retiros y depósitos', icon: ArrowLeftRight, phase: 3 },
  { to: '/worker', label: 'Control del worker', icon: Gauge, phase: 3, ejecutivo: true },
  { to: '/fiat-automaticos', label: 'Proveedores regulados', icon: Euro, phase: 3 },
  { to: '/rieles-fiat', label: 'Control de Rieles Fiat', icon: Landmark, phase: 3, ejecutivo: true },
  { to: '/compensacion', label: 'Compensación', icon: Network, phase: 4 },
  { to: '/aprobaciones', label: 'Aprobaciones', icon: CheckCheck, phase: 5 },
  { to: '/auditoria', label: 'Auditoría', icon: FileClock, phase: 5, tesorero: true },
  { to: '/operadores', label: 'Operadores', icon: UsersRound, phase: 5, tesorero: true },
  { to: '/consumos', label: 'Consumos y topes', icon: Wallet, phase: 5, tesorero: true },
  { to: '/seguridad', label: 'Seguridad', icon: KeyRound, phase: 5 },
] as const;
const CURRENT_PHASE = 5;

const ROLE_LABEL = { lectura: 'Lectura', ejecutivo: 'Ejecutivo de cuenta', tesorero: 'Tesorero' } as const;

export function Layout() {
  const { operator, logout, can } = useAuth();
  const [open, setOpen] = useState(false);
  const summary = useQuery({ queryKey: ['summary'], queryFn: () => api<Summary>('/summary'), refetchInterval: 15_000, enabled: !!operator });
  const usage = useQuery({ queryKey: ['usage'], queryFn: () => api<UsageOverview>('/usage'), refetchInterval: 60_000, enabled: !!operator && can('tesorero') });
  const usageAlerts = usage.data?.alerts ?? 0;
  const ap = summary.data?.approvals_pending;
  const pending = (ap?.withdrawals ?? 0) + (ap?.netting_runs ?? 0) + (ap?.asset_requests ?? 0) + (ap?.deposits_held ?? 0);
  const nav: readonly (typeof NAV)[number][] = NAV.filter((n: (typeof NAV)[number]) => (!('tesorero' in n) || can('tesorero')) && (!('ejecutivo' in n) || can('ejecutivo')));

  const sidebar = (
    <nav className="flex h-full flex-col gap-1 p-3">
      <div className="mb-4 flex items-center gap-2 px-2 pt-1">
        <div className="grid size-8 place-items-center rounded-md bg-white/10 font-mono text-xs font-bold text-white">856</div>
        <div className="leading-tight">
          <div className="text-sm font-semibold text-white">856-LATAM</div>
          <div className="text-[11px] text-sidebar-muted">Consola de operación</div>
        </div>
      </div>
      {nav.map(({ to, label, icon: Icon, phase }) => phase <= CURRENT_PHASE ? (
        <NavLink key={to} to={to} end={to === '/'} onClick={() => setOpen(false)}
          className={({ isActive }) => cn('flex items-center gap-2.5 rounded-md px-2.5 py-2 text-sm text-sidebar-foreground hover:bg-sidebar-accent',
            isActive && 'bg-sidebar-accent font-medium text-white')}>
          <Icon className="size-4" /><span className="flex-1">{label}</span>
          {to === '/aprobaciones' && pending > 0 && <span className="num rounded bg-warning px-1.5 text-[11px] font-semibold text-black" aria-label={`${pending} pendientes`}>{pending}</span>}
          {to === '/consumos' && usageAlerts > 0 && <span className="num rounded bg-warning px-1.5 text-[11px] font-semibold text-black" aria-label={`${usageAlerts} alertas de consumo`}>{usageAlerts}</span>}
        </NavLink>
      ) : (
        <div key={to} aria-disabled className="flex cursor-not-allowed items-center gap-2.5 rounded-md px-2.5 py-2 text-sm text-sidebar-muted/70">
          <Icon className="size-4" /><span className="flex-1 truncate">{label}</span>
          <span className="rounded bg-white/5 px-1.5 py-0.5 text-[10px]">Fase {phase}</span>
        </div>
      ))}
      <div className="mt-auto rounded-md border border-white/10 p-3 text-xs text-sidebar-muted">
        <div className="flex items-center gap-1.5 text-sidebar-foreground"><ShieldCheck className="size-3.5" /> Sesión segura</div>
        <p className="mt-1">Cookie httpOnly · cierre por inactividad</p>
        {operator && <p className="mt-1">{operator.totp_enabled ? '2FA activo' : <NavLink to="/seguridad" className="underline" onClick={() => setOpen(false)}>Activar 2FA</NavLink>}</p>}
      </div>
    </nav>
  );

  return (
    <div className="flex min-h-dvh">
      <aside className="hidden w-64 shrink-0 bg-sidebar lg:block">{sidebar}</aside>
      {open && (
        <div className="fixed inset-0 z-40 lg:hidden">
          <div className="absolute inset-0 bg-black/40" onClick={() => setOpen(false)} />
          <aside className="absolute inset-y-0 left-0 w-64 bg-sidebar">{sidebar}</aside>
        </div>
      )}
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-30 flex h-14 items-center gap-3 border-b bg-background/90 px-4 backdrop-blur">
          <Button variant="ghost" size="icon" className="lg:hidden" onClick={() => setOpen(!open)} aria-label="Menú">
            {open ? <X /> : <Menu />}
          </Button>
          <EnvBadge />
          <div className="flex-1" />
          {operator && (
            <div className="flex items-center gap-3">
              <div className="hidden text-right leading-tight sm:block">
                <div className="text-sm font-medium">{operator.name}</div>
                <div className="text-xs text-muted-foreground">{operator.email}</div>
              </div>
              <Badge variant="secondary">{ROLE_LABEL[operator.role]}</Badge>
              <Button variant="outline" size="sm" onClick={() => logout()}><LogOut />Salir</Button>
            </div>
          )}
        </header>
        <main className="min-w-0 flex-1 p-4 md:p-6"><Outlet /></main>
      </div>
    </div>
  );
}
