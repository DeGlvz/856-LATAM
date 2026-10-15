// Portal fase 4 — compensación: posición propia en la próxima corrida (sobre lo aceptado) e historial de corridas
// donde participó, con su renglón del asiento. Nunca muestra posiciones ni nombres de terceros.
import { useState } from 'react';
import { Link } from 'react-router';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { AlertTriangle } from 'lucide-react';
import { OB_STATE, papi, type MyPosition, type MyRun, type MyRunRow } from '../api';
import { Money } from '../money';
import { ErrorBox, fmtDate } from '@/components/common';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';

const pct = (bps: number) => `${(bps / 100).toFixed(2)} %`;
const signed = (v: string, decimals: number, symbol: string) => {
  const n = BigInt(v);
  return <Money v={(n < 0n ? -n : n).toString()} decimals={decimals} symbol={symbol} sign={n < 0n ? '−' : n > 0n ? '+' : undefined} className={n < 0n ? 'text-destructive' : n > 0n ? 'text-success' : ''} />;
};

export function Netting() {
  const pos = useQuery({ queryKey: ['p-positions'], queryFn: () => papi<{ positions: MyPosition[] }>('/netting/positions'), refetchInterval: 60_000 });
  const runs = useInfiniteQuery({
    queryKey: ['p-runs'], initialPageParam: null as string | null,
    queryFn: ({ pageParam }) => papi<{ runs: MyRunRow[]; next_cursor: string | null }>(`/netting/runs?limit=50${pageParam ? `&cursor=${pageParam}` : ''}`),
    getNextPageParam: (l) => l.next_cursor,
  });
  const [open, setOpen] = useState<string | null>(null);
  const list = pos.data?.positions ?? [];
  const rows = runs.data?.pages.flatMap((p) => p.runs) ?? [];

  return (
    <div className="mx-auto grid max-w-6xl grid-cols-[minmax(0,1fr)] gap-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Compensación</h1>
        <p className="text-sm text-muted-foreground">856 compensa sus obligaciones aceptadas con las de otros participantes: usted solo paga o recibe la diferencia.</p>
      </div>

      <section aria-labelledby="posicion" className="grid gap-3">
        <h2 id="posicion" className="text-base font-semibold">Su posición en la próxima corrida</h2>
        <ErrorBox error={pos.error} />
        {pos.isPending && <Skeleton className="h-36" />}
        {pos.data && !list.length && <Card><CardContent className="py-6 text-sm text-muted-foreground">No tiene obligaciones aceptadas pendientes de compensar. <Link to="/obligaciones" className="underline">Ver obligaciones</Link></CardContent></Card>}
        <div className="grid gap-4 md:grid-cols-2">
          {list.map((p) => (
            <Card key={p.asset_id} data-position={p.asset_id}>
              <CardHeader>
                <CardDescription>{p.symbol} · {p.open_obligations} obligación(es) aceptada(s)</CardDescription>
                <CardTitle className="text-2xl">{signed(p.net, p.decimals, p.symbol)}</CardTitle>
              </CardHeader>
              <CardContent className="grid gap-2">
                <dl className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-sm">
                  <dt className="text-muted-foreground">Por cobrar</dt><dd className="text-right"><Money v={p.receivable} decimals={p.decimals} /></dd>
                  <dt className="text-muted-foreground">Por pagar</dt><dd className="text-right"><Money v={p.payable} decimals={p.decimals} /></dd>
                  <dt className="text-muted-foreground">Neto ({BigInt(p.net) < 0n ? 'pagará' : BigInt(p.net) > 0n ? 'recibirá' : 'sin movimiento'})</dt><dd className="text-right font-medium">{signed(p.net, p.decimals, p.symbol)}</dd>
                  <dt className="text-muted-foreground">Ahorro estimado</dt><dd className="text-right text-success"><Money v={p.savings} decimals={p.decimals} /> · {pct(p.savings_bps)}</dd>
                </dl>
                {p.shortfall !== '0' && (
                  <p role="status" className="flex items-start gap-2 rounded-md border border-warning/60 bg-warning/10 p-2 text-xs">
                    <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />Su saldo disponible no cubre el neto a pagar: faltan <Money v={p.shortfall} decimals={p.decimals} symbol={p.symbol} />. Deposite antes del corte.
                  </p>
                )}
              </CardContent>
            </Card>
          ))}
        </div>
        <p className="text-xs text-muted-foreground">Estimación con las obligaciones aceptadas a este momento; la corrida la ejecuta la tesorería de 856 y puede incluir solo una parte.</p>
      </section>

      <Card>
        <CardHeader><CardTitle className="text-base">Corridas en las que participó</CardTitle><CardDescription>Cada corrida genera un solo asiento: abono o cargo por su neto.</CardDescription></CardHeader>
        <CardContent className="grid gap-3">
          <ErrorBox error={runs.error} />
          {runs.isPending && <Skeleton className="h-20" />}
          {runs.data && !rows.length && <p className="py-4 text-center text-sm text-muted-foreground">Aún no participa en corridas liquidadas.</p>}
          {!!rows.length && (
            <div className="overflow-x-auto">
              <Table aria-label="Corridas">
                <TableHeader><TableRow><TableHead>Liquidada</TableHead><TableHead>Activo</TableHead><TableHead className="text-right">Por cobrar</TableHead><TableHead className="text-right">Por pagar</TableHead><TableHead className="text-right">Neto</TableHead><TableHead /></TableRow></TableHeader>
                <TableBody>
                  {rows.map((r) => (
                    <TableRow key={r.id} data-run={r.id}>
                      <TableCell className="text-xs whitespace-nowrap">{fmtDate(r.decided_at ?? r.created_at)}</TableCell>
                      <TableCell>{r.symbol}</TableCell>
                      <TableCell className="text-right"><Money v={r.receivable} decimals={r.decimals} /></TableCell>
                      <TableCell className="text-right"><Money v={r.payable} decimals={r.decimals} /></TableCell>
                      <TableCell className="text-right">{signed(r.net, r.decimals, r.symbol)}</TableCell>
                      <TableCell className="text-right"><Button size="sm" variant="ghost" onClick={() => setOpen(r.id)}>Ver detalle</Button></TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
          {runs.hasNextPage && <div className="text-center"><Button variant="outline" size="sm" onClick={() => runs.fetchNextPage()}>Cargar más</Button></div>}
        </CardContent>
      </Card>
      <RunDialog id={open} onClose={() => setOpen(null)} />
    </div>
  );
}

function RunDialog({ id, onClose }: { id: string | null; onClose: () => void }) {
  const q = useQuery({ queryKey: ['p-run', id], enabled: !!id, queryFn: () => papi<MyRun>(`/netting/runs/${id}`) });
  const r = q.data;
  return (
    <Dialog open={!!id} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader><DialogTitle>Corrida de compensación</DialogTitle>
          <DialogDescription className="font-mono text-xs">{id}</DialogDescription></DialogHeader>
        <ErrorBox error={q.error} />
        {q.isPending && <Skeleton className="h-32" />}
        {r && (
          <div className="grid gap-3 text-sm">
            <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1.5">
              <dt className="text-muted-foreground">Liquidada</dt><dd>{fmtDate(r.decided_at ?? r.created_at)}</dd>
              <dt className="text-muted-foreground">Neto</dt><dd>{signed(r.net, r.decimals, r.symbol)}</dd>
              {r.entry && <><dt className="text-muted-foreground">Asiento</dt><dd data-testid="run-entry">
                <Badge variant={r.entry.kind === 'abono' ? 'success' : 'secondary'}>{r.entry.kind === 'abono' ? 'Abono' : 'Cargo'}</Badge>{' '}
                <Money v={r.entry.amount} decimals={r.decimals} symbol={r.symbol} exact /> · saldo resultante <Money v={r.entry.balance_after} decimals={r.decimals} /></dd></>}
            </dl>
            <h3 className="font-medium">Sus obligaciones liquidadas ({r.obligations.length})</h3>
            <div className="overflow-x-auto">
              <Table aria-label="Obligaciones de la corrida">
                <TableHeader><TableRow><TableHead>Tipo</TableHead><TableHead>Contraparte</TableHead><TableHead>Referencia</TableHead><TableHead className="text-right">Monto</TableHead><TableHead>Estado</TableHead></TableRow></TableHeader>
                <TableBody>{r.obligations.map((o) => (
                  <TableRow key={o.id}>
                    <TableCell>{o.role === 'creditor' ? 'Por cobrar' : 'Por pagar'}</TableCell><TableCell>{o.counterparty.name}</TableCell>
                    <TableCell className="font-mono text-xs">{o.external_ref ?? '—'}</TableCell>
                    <TableCell className="text-right"><Money v={o.amount} decimals={o.decimals} /></TableCell>
                    <TableCell><Badge variant={OB_STATE[o.status].v}>{OB_STATE[o.status].t}</Badge></TableCell>
                  </TableRow>))}
                </TableBody>
              </Table>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
