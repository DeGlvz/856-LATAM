import { Link } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { ArrowRight, KeyRound, ShieldCheck, Users } from 'lucide-react';
import { papi, ROLE_HELP, ROLE_LABEL, type ActivityLine, type BalanceRow, type Notice } from '../api';
import { usePortal } from '../auth';
import { Money, NoticesBand } from '../money';
import { CounterpartyCode } from './Obligations';
import { ErrorBox, StatusBadge, fmtDate } from '@/components/common';
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import type { ClientStatus } from '@/lib/api';

export function Home() {
  const { me, isAdmin } = usePortal();
  const bal = useQuery({ queryKey: ['p-balances'], queryFn: () => papi<{ as_of: string; balances: BalanceRow[] }>('/balances'), refetchInterval: 60_000 });
  const act = useQuery({ queryKey: ['p-activity'], queryFn: () => papi<{ items: ActivityLine[] }>('/activity?limit=10') });
  const notices = useQuery({ queryKey: ['p-notices'], queryFn: () => papi<{ notices: Notice[] }>('/notices') });
  if (!me) return null;
  const rows = bal.data?.balances ?? [];

  return (
    <div className="mx-auto grid max-w-6xl grid-cols-[minmax(0,1fr)] gap-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Bienvenido, {me.user.name.split(' ')[0]}</h1>
        <p className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">{me.client.name} <StatusBadge status={me.client.status as ClientStatus} /></p>
        <div className="mt-2"><CounterpartyCode compact /></div>
      </div>

      <NoticesBand notices={notices.data?.notices ?? []} isAdmin={isAdmin} />

      <section aria-labelledby="saldos" className="grid gap-3">
        <div className="flex flex-wrap items-end justify-between gap-2">
          <h2 id="saldos" className="text-base font-semibold">Saldos</h2>
          {bal.data && <span className="text-xs text-muted-foreground">Al {fmtDate(bal.data.as_of)}</span>}
        </div>
        <ErrorBox error={bal.error} />
        {bal.isPending && <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3"><Skeleton className="h-40" /><Skeleton className="h-40" /></div>}
        {bal.data && !rows.length && <Card><CardContent className="py-6 text-sm text-muted-foreground">Aún no tiene cuentas con saldo. Genere una dirección en <Link to="/depositos" className="underline">Depósitos</Link> para recibir fondos.</CardContent></Card>}
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {rows.map((b) => (
            <Card key={b.asset_id} data-asset={b.asset_id}>
              <CardHeader>
                <CardDescription>{b.symbol} · <span className="font-mono text-xs">{b.network}</span></CardDescription>
                <CardTitle className="text-2xl"><Money v={b.available} decimals={b.decimals} symbol={b.symbol} /></CardTitle>
                <CardAction><Link to={`/cuentas/${b.asset_id}`} className="inline-flex items-center gap-1 text-sm underline">Movimientos<ArrowRight className="size-3.5" /></Link></CardAction>
              </CardHeader>
              <CardContent>
                <dl className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-sm">
                  <dt className="text-muted-foreground">Disponible</dt><dd className="text-right"><Money v={b.available} decimals={b.decimals} /></dd>
                  <dt className="text-muted-foreground" title="Retiros solicitados que aún no se confirman en la red">Reservado en retiros</dt><dd className="text-right"><Money v={b.reserved} decimals={b.decimals} /></dd>
                  <dt className="text-muted-foreground">Total</dt><dd className="text-right font-medium"><Money v={b.total} decimals={b.decimals} /></dd>
                  <div className="col-span-2 my-0.5 border-t" aria-hidden /><dt className="text-muted-foreground">Por pagar</dt><dd className="text-right"><Money v={b.payable} decimals={b.decimals} /></dd>
                  <dt className="text-muted-foreground">Por cobrar</dt><dd className="text-right"><Money v={b.receivable} decimals={b.decimals} /></dd>
                </dl>
              </CardContent>
            </Card>
          ))}
        </div>
      </section>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Movimientos recientes</CardTitle>
          <CardDescription>Los últimos 10 de todas sus cuentas.</CardDescription>
          <CardAction><Link to="/cuentas" className="text-sm underline">Ver cuentas</Link></CardAction>
        </CardHeader>
        <CardContent>
          <ErrorBox error={act.error} />
          {act.isPending && <Skeleton className="h-24" />}
          {act.data && !act.data.items.length && <p className="text-sm text-muted-foreground">Sin movimientos todavía.</p>}
          {!!act.data?.items.length && (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader><TableRow><TableHead>Fecha</TableHead><TableHead>Concepto</TableHead><TableHead className="text-right">Monto</TableHead><TableHead /></TableRow></TableHeader>
                <TableBody>
                  {act.data.items.map((l) => (
                    <TableRow key={`${l.id}-${l.asset_id}`}>
                      <TableCell className="text-xs whitespace-nowrap text-muted-foreground">{fmtDate(l.created_at)}</TableCell>
                      <TableCell className="text-sm">{l.label}</TableCell>
                      <TableCell className={l.direction === 'credit' ? 'text-right text-success' : 'text-right'}>
                        <Money v={l.amount} decimals={l.decimals} symbol={l.symbol} sign={l.direction === 'credit' ? '+' : '−'} />
                      </TableCell>
                      <TableCell className="text-right"><Link to={`/cuentas/${l.asset_id}`} className="text-xs underline">Cuenta</Link></TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      <div className="grid gap-4 md:grid-cols-3">
        <Card className="gap-2 py-4"><CardHeader><CardTitle className="flex items-center gap-2 text-sm"><ShieldCheck className="size-4" />Su acceso: {ROLE_LABEL[me.user.role]}</CardTitle>
          <CardDescription>{ROLE_HELP[me.user.role]} {me.user.totp_enabled ? 'Verificación en dos pasos activa.' : <Link to="/seguridad" className="underline">Activar verificación en dos pasos</Link>}</CardDescription></CardHeader></Card>
        {isAdmin && <>
          <Card className="gap-2 py-4"><CardHeader><CardTitle className="flex items-center gap-2 text-sm"><Users className="size-4" />Usuarios</CardTitle>
            <CardDescription>Invite a su equipo y defina qué puede hacer cada persona. <Link to="/usuarios" className="underline">Administrar</Link></CardDescription></CardHeader></Card>
          <Card className="gap-2 py-4"><CardHeader><CardTitle className="flex items-center gap-2 text-sm"><KeyRound className="size-4" />Integración por API</CardTitle>
            <CardDescription>Llaves para que su ERP o tesorería consulte saldos y movimientos. <Link to="/llaves" className="underline">Administrar</Link></CardDescription></CardHeader></Card>
        </>}
      </div>
    </div>
  );
}
