import { useState } from 'react';
import { NavLink, Outlet } from 'react-router';
import {
  ArrowLeftRight, Building2, FileClock, Gauge, LogOut, Menu, Network, ShieldCheck, X,
} from 'lucide-react';
import { useAuth } from '@/lib/auth';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';

const NAV = [
  { to: '/', label: 'Tablero', icon: Gauge, phase: 1 },
  { to: '/clientes', label: 'Clientes y cuentas', icon: Building2, phase: 2 },
  { to: '/movimientos', label: 'Retiros, depósitos y barridos', icon: ArrowLeftRight, phase: 3 },
  { to: '/compensacion', label: 'Compensación', icon: Network, phase: 4 },
  { to: '/auditoria', label: 'Auditoría', icon: FileClock, phase: 5 },
] as const;
const CURRENT_PHASE = 1;

const ROLE_LABEL = { lectura: 'Lectura', operador: 'Operador', tesorero: 'Tesorero' } as const;

export function Layout() {
  const { operator, logout } = useAuth();
  const [open, setOpen] = useState(false);

  const sidebar = (
    <nav className="flex h-full flex-col gap-1 p-3">
      <div className="mb-4 flex items-center gap-2 px-2 pt-1">
        <div className="grid size-8 place-items-center rounded-md bg-white/10 font-mono text-xs font-bold text-white">856</div>
        <div className="leading-tight">
          <div className="text-sm font-semibold text-white">856-LATAM</div>
          <div className="text-[11px] text-sidebar-muted">Consola de operación</div>
        </div>
      </div>
      {NAV.map(({ to, label, icon: Icon, phase }) => phase <= CURRENT_PHASE ? (
        <NavLink key={to} to={to} end onClick={() => setOpen(false)}
          className={({ isActive }) => cn('flex items-center gap-2.5 rounded-md px-2.5 py-2 text-sm text-sidebar-foreground hover:bg-sidebar-accent',
            isActive && 'bg-sidebar-accent font-medium text-white')}>
          <Icon className="size-4" />{label}
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
