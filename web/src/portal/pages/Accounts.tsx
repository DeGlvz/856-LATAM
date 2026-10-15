import { useState, type FormEvent } from 'react';
import { Link, useParams } from 'react-router';
import { useInfiniteQuery, useMutation, useQuery } from '@tanstack/react-query';
import { ArrowLeft, Download, FileText, Loader2 } from 'lucide-react';
import { ApiError, downloadPortal, netLabel, papi, type BalanceRow, type EntriesPage, type Line, type Statement } from '../api';
import { Money, RefCell, fmtUtc, lastMonths } from '../money';
import { ErrorBox, Field, fmtDate } from '@/components/common';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';

// ───────────── Lista de cuentas ─────────────
export function Accounts() {
  const q = useQuery({ queryKey: ['p-balances'], queryFn: () => papi<{ as_of: string; balances: BalanceRow[] }>('/balances') });
  return (
    <div className="mx-auto grid max-w-5xl grid-cols-[minmax(0,1fr)] gap-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Cuentas</h1>
        <p className="text-sm text-muted-foreground">Una cuenta por activo. Abra una para ver su historial, descargarlo o consultar el estado de cuenta mensual.</p>
      </div>
      <ErrorBox error={q.error} />
      <Card className="py-2"><CardContent className="px-3">
        {q.isPending && <Skeleton className="h-24" />}
        {q.data && !q.data.balances.length && <p className="py-6 text-center text-sm text-muted-foreground">Aún no tiene cuentas.</p>}
        {!!q.data?.balances.length && (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader><TableRow><TableHead>Activo</TableHead><TableHead className="text-right">Disponible</TableHead><TableHead className="text-right">Reservado</TableHead><TableHead className="text-right">Total</TableHead><TableHead /></TableRow></TableHeader>
              <TableBody>
                {q.data.balances.map((b) => (
                  <TableRow key={b.asset_id}>
                    <TableCell><div className="font-medium">{b.symbol}{b.asset_status === 'exit_only' && <Badge variant="secondary" className="ml-2" data-testid="exit-only">Solo salida</Badge>}</div><div className="text-xs text-muted-foreground">{netLabel(b.network)} · <span className="font-mono">{b.asset_id}</span></div></TableCell>
                    <TableCell className="text-right"><Money v={b.available} decimals={b.decimals} /></TableCell>
                    <TableCell className="text-right"><Money v={b.reserved} decimals={b.decimals} /></TableCell>
                    <TableCell className="text-right font-medium"><Money v={b.total} decimals={b.decimals} /></TableCell>
                    <TableCell className="text-right"><Button asChild size="sm" variant="outline"><Link to={`/cuentas/${b.asset_id}`}>Abrir</Link></Button></TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent></Card>
    </div>
  );
}

// ───────────── Detalle: historial, CSV y estado de cuenta ─────────────
const toIso = (d: string, endOfDay = false) => (d ? new Date(`${d}T00:00:00Z`).getTime() + (endOfDay ? 86_400_000 : 0) : null);

export function AccountDetail() {
  const { asset = '' } = useParams();
  const [range, setRange] = useState<{ from: string; to: string }>({ from: '', to: '' });
  const [draft, setDraft] = useState(range);
  const qs = () => {
    const p = new URLSearchParams();
    const f = toIso(range.from), t = toIso(range.to, true); // "hasta" incluye todo ese día (UTC)
    if (f != null) p.set('from', new Date(f).toISOString());
    if (t != null) p.set('to', new Date(t).toISOString());
    return p;
  };
  const q = useInfiniteQuery({
    queryKey: ['p-entries', asset, range],
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) => { const p = qs(); p.set('limit', '50'); if (pageParam) p.set('cursor', pageParam); return papi<EntriesPage>(`/accounts/${encodeURIComponent(asset)}/entries?${p}`); },
    getNextPageParam: (last) => last.next_cursor,
    retry: (n, e) => !(e instanceof ApiError && e.status < 500) && n < 2,
  });
  const csv = useMutation({ mutationFn: () => downloadPortal(`/accounts/${encodeURIComponent(asset)}/entries.csv?${qs()}`, `movimientos-${asset}.csv`) });
  const first = q.data?.pages[0];
  const entries = q.data?.pages.flatMap((p) => p.entries) ?? [];
  const notFound = q.error instanceof ApiError && q.error.status === 404;

  if (notFound) {
    return (
      <div className="mx-auto grid max-w-3xl gap-4">
        <Link to="/cuentas" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:underline"><ArrowLeft className="size-4" />Cuentas</Link>
        <Card><CardContent className="py-8 text-center text-sm" role="alert">No se encontró la cuenta <span className="font-mono">{asset}</span> en su empresa.</CardContent></Card>
      </div>
    );
  }
  const a = first?.asset;
  return (
    <div className="mx-auto grid max-w-6xl grid-cols-[minmax(0,1fr)] gap-6">
      <div>
        <Link to="/cuentas" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:underline"><ArrowLeft className="size-4" />Cuentas</Link>
        <h1 className="mt-1 text-xl font-semibold tracking-tight">{a ? `${a.symbol}` : asset}</h1>
        {a && first && <p className="text-sm text-muted-foreground">Saldo disponible: <Money v={first.balance} decimals={a.decimals} symbol={a.symbol} className="text-foreground" /> · <span className="text-xs">{netLabel(a.network)}</span></p>}
      </div>
      <ErrorBox error={notFound ? null : q.error} />

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Movimientos</CardTitle>
          <CardDescription>Fechas en su hora local; el filtro y los archivos usan días en UTC.</CardDescription>
          <CardAction>
            <Button size="sm" variant="outline" onClick={() => csv.mutate()} disabled={csv.isPending || !a}>{csv.isPending ? <Loader2 className="animate-spin" /> : <Download />}Descargar CSV</Button>
          </CardAction>
        </CardHeader>
        <CardContent className="grid gap-4">
          <form className="flex flex-wrap items-end gap-3" onSubmit={(e: FormEvent) => { e.preventDefault(); setRange(draft); }}>
            <Field label="Desde (UTC)" htmlFor="f-from"><Input id="f-from" type="date" className="w-40" value={draft.from} onChange={(e) => setDraft({ ...draft, from: e.target.value })} /></Field>
            <Field label="Hasta (UTC)" htmlFor="f-to"><Input id="f-to" type="date" className="w-40" value={draft.to} onChange={(e) => setDraft({ ...draft, to: e.target.value })} /></Field>
            <Button type="submit" variant="secondary" size="sm">Filtrar</Button>
            {(range.from || range.to) && <Button type="button" variant="ghost" size="sm" onClick={() => { const z = { from: '', to: '' }; setDraft(z); setRange(z); }}>Quitar filtro</Button>}
          </form>
          <ErrorBox error={csv.error} />
          {q.isPending && <Skeleton className="h-40" />}
          {a && <LinesTable lines={entries} decimals={a.decimals} network={a.network} />}
          {q.data && !entries.length && <p className="py-4 text-center text-sm text-muted-foreground">Sin movimientos en este periodo.</p>}
          {q.hasNextPage && (
            <div className="text-center"><Button variant="outline" size="sm" onClick={() => q.fetchNextPage()} disabled={q.isFetchingNextPage}>{q.isFetchingNextPage && <Loader2 className="animate-spin" />}Cargar más</Button></div>
          )}
        </CardContent>
      </Card>

      {a && <StatementCard asset={asset} />}
    </div>
  );
}

function LinesTable({ lines, decimals, network }: { lines: Line[]; decimals: number; network: string }) {
  if (!lines.length) return null;
  return (
    <div className="overflow-x-auto">
      <Table aria-label="Movimientos de la cuenta">
        <TableHeader><TableRow><TableHead>Fecha</TableHead><TableHead>Concepto</TableHead><TableHead className="text-right">Cargo</TableHead><TableHead className="text-right">Abono</TableHead><TableHead className="text-right">Saldo</TableHead><TableHead>Referencia</TableHead></TableRow></TableHeader>
        <TableBody>
          {lines.map((l) => (
            <TableRow key={l.id} data-entry={l.id}>
              <TableCell className="text-xs whitespace-nowrap text-muted-foreground" title={`${fmtUtc(l.created_at)} UTC`}>{fmtDate(l.created_at)}</TableCell>
              <TableCell className="text-sm">{l.label}</TableCell>
              <TableCell className="text-right">{l.direction === 'debit' ? <Money v={l.amount} decimals={decimals} /> : ''}</TableCell>
              <TableCell className="text-right text-success">{l.direction === 'credit' ? <Money v={l.amount} decimals={decimals} /> : ''}</TableCell>
              <TableCell className="text-right"><Money v={l.balance_after} decimals={decimals} /></TableCell>
              <TableCell><RefCell l={l} network={network} /></TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

function StatementCard({ asset }: { asset: string }) {
  const months = lastMonths();
  const [period, setPeriod] = useState(months[0].v);
  const q = useQuery({ queryKey: ['p-statement', asset, period], queryFn: () => papi<Statement>(`/statements/${period}?asset=${encodeURIComponent(asset)}`) });
  const csv = useMutation({ mutationFn: () => downloadPortal(`/statements/${period}.csv?asset=${encodeURIComponent(asset)}`, `estado-de-cuenta-${asset}-${period}.csv`) });
  const s = q.data;
  const d = s?.asset.decimals ?? 0;
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base"><FileText className="size-4" />Estado de cuenta</CardTitle>
        <CardDescription>Mes calendario en UTC. Saldo inicial + abonos − cargos = saldo final.</CardDescription>
        <CardAction className="flex flex-wrap items-center gap-2">
          <Select aria-label="Mes del estado de cuenta" className="h-8 w-44" value={period} onChange={(e) => setPeriod(e.target.value)}>
            {months.map((m) => <option key={m.v} value={m.v}>{m.label}</option>)}
          </Select>
          <Button size="sm" variant="outline" onClick={() => csv.mutate()} disabled={csv.isPending}>{csv.isPending ? <Loader2 className="animate-spin" /> : <Download />}CSV</Button>
        </CardAction>
      </CardHeader>
      <CardContent className="grid gap-4">
        <ErrorBox error={q.error ?? csv.error} />
        {q.isPending && <Skeleton className="h-24" />}
        {s && (
          <>
            <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4" aria-label="Resumen del estado de cuenta">
              {([['Saldo inicial', s.opening_balance], ['Abonos', s.credits], ['Cargos', s.debits], ['Saldo final', s.closing_balance]] as const).map(([k, v]) => (
                <div key={k} className="rounded-md border p-3"><dt className="text-xs text-muted-foreground">{k}</dt><dd className="mt-1 text-lg"><Money v={v} decimals={d} exact /></dd></div>
              ))}
            </dl>
            {s.entries.length ? <LinesTable lines={s.entries} decimals={d} network={s.asset.network} /> : <p className="text-center text-sm text-muted-foreground">Sin movimientos en {months.find((m) => m.v === period)?.label}.</p>}
          </>
        )}
      </CardContent>
    </Card>
  );
}
