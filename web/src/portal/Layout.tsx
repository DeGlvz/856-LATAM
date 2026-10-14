import { useState } from 'react';
import { NavLink, Outlet } from 'react-router';
import { ArrowDownToLine, ArrowUpFromLine, ListChecks, Home as HomeIcon, KeyRound, Landmark, LogOut, Menu, ShieldCheck, Users as UsersIcon, X, Wallet } from 'lucide-react';
import { usePortal } from './auth';
import { ROLE_LABEL } from './api';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';

const NAV = [
  { to: '/', label: 'Inicio', icon: HomeIcon },
  { to: '/cuentas', label: 'Cuentas', icon: Landmark },
  { to: '/depositos', label: 'Depósitos', icon: ArrowDownToLine },
  { to: '/salidas', label: 'Salidas', icon: ArrowUpFromLine },
  { to: '/lista-blanca', label: 'Lista blanca', icon: ListChecks },
  { to: '/usuarios', label: 'Usuarios', icon: UsersIcon, admin: true },
  { to: '/llaves', label: 'Llaves de API', icon: KeyRound, admin: true },
  { to: '/seguridad', label: 'Seguridad', icon: ShieldCheck },
];

export function PortalLayout() {
  const { me, logout, isAdmin } = usePortal();
  const [open, setOpen] = useState(false);
  const enrolling = !!me?.totp_enrollment_required;
  const items = NAV.filter((n) => (!n.admin || isAdmin) && (!enrolling || n.to === '/seguridad'));
  const sidebar = (
    <nav className="flex h-full flex-col gap-1 p-3">
      <div className="mb-4 flex items-center gap-2 px-2 pt-1">
        <div className="grid size-8 place-items-center rounded-md bg-white/15 text-white"><Wallet className="size-4" /></div>
        <div className="min-w-0 leading-tight">
          <div className="truncate text-sm font-semibold text-white">{me?.client.name ?? '856-LATAM'}</div>
          <div className="text-[11px] text-sidebar-muted">Portal de clientes · 856-LATAM</div>
        </div>
      </div>
      {items.map(({ to, label, icon: Icon }) => (
        <NavLink key={to} to={to} end={to === '/'} onClick={() => setOpen(false)}
          className={({ isActive }) => cn('flex items-center gap-2.5 rounded-md px-2.5 py-2 text-sm text-sidebar-foreground hover:bg-sidebar-accent', isActive && 'bg-sidebar-accent font-medium text-white')}>
          <Icon className="size-4" />{label}
        </NavLink>
      ))}
      <div className="mt-auto rounded-md border border-white/10 p-3 text-xs text-sidebar-muted">
        Solo usted ve la información de su empresa. Ningún usuario de 856 puede operar a su nombre.
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
          <Button variant="ghost" size="icon" className="lg:hidden" onClick={() => setOpen(!open)} aria-label="Menú">{open ? <X /> : <Menu />}</Button>
          <div className="flex-1" />
          {me && (
            <div className="flex items-center gap-3">
              <div className="hidden text-right leading-tight sm:block">
                <div className="text-sm font-medium">{me.user.name}</div>
                <div className="text-xs text-muted-foreground">{me.user.email}</div>
              </div>
              <Badge variant="secondary">{ROLE_LABEL[me.user.role]}</Badge>
              <Button variant="outline" size="sm" onClick={() => logout()}><LogOut />Salir</Button>
            </div>
          )}
        </header>
        <main className="min-w-0 flex-1 p-4 md:p-6"><Outlet /></main>
      </div>
    </div>
  );
}
