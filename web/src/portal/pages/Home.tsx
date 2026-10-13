import { Link } from 'react-router';
import { KeyRound, ShieldCheck, Users } from 'lucide-react';
import { ROLE_HELP, ROLE_LABEL } from '../api';
import { usePortal } from '../auth';
import { StatusBadge } from '@/components/common';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import type { ClientStatus } from '@/lib/api';

export function Home() {
  const { me, isAdmin } = usePortal();
  if (!me) return null;
  return (
    <div className="mx-auto grid max-w-5xl grid-cols-[minmax(0,1fr)] gap-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Bienvenido, {me.user.name.split(' ')[0]}</h1>
        <p className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">{me.client.name} <StatusBadge status={me.client.status as ClientStatus} /></p>
      </div>
      <div className="grid gap-4 md:grid-cols-3">
        <Card><CardHeader><CardTitle className="flex items-center gap-2 text-base"><ShieldCheck className="size-4" />Su acceso</CardTitle>
          <CardDescription>{ROLE_LABEL[me.user.role]}: {ROLE_HELP[me.user.role]}</CardDescription></CardHeader>
          <CardContent className="text-sm">{me.user.totp_enabled ? 'Verificación en dos pasos activa.' : <Link to="/seguridad" className="underline">Activar verificación en dos pasos</Link>}</CardContent></Card>
        {isAdmin && <>
          <Card><CardHeader><CardTitle className="flex items-center gap-2 text-base"><Users className="size-4" />Usuarios</CardTitle>
            <CardDescription>Invite a su equipo y defina qué puede hacer cada persona.</CardDescription></CardHeader>
            <CardContent className="text-sm"><Link to="/usuarios" className="underline">Administrar usuarios</Link></CardContent></Card>
          <Card><CardHeader><CardTitle className="flex items-center gap-2 text-base"><KeyRound className="size-4" />Integración por API</CardTitle>
            <CardDescription>Llaves firmadas para que su ERP o tesorería se conecte de forma segura.</CardDescription></CardHeader>
            <CardContent className="text-sm"><Link to="/llaves" className="underline">Administrar llaves</Link></CardContent></Card>
        </>}
      </div>
      <Card><CardContent className="py-6 text-sm text-muted-foreground">
        Próximamente en este portal: saldos y estado de cuenta, depósitos, retiros con simulación y validación, y obligaciones con compensación.
      </CardContent></Card>
    </div>
  );
}
