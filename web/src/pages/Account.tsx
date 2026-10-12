import { useState } from 'react';
import { Link, useParams } from 'react-router';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { ArrowLeft, Loader2 } from 'lucide-react';
import { api, type Account as TAccount, type AccountPosting } from '@/lib/api';
import { ENTRY_KIND, useAssets } from '@/lib/hooks';
import { Amount, CopyButton, ErrorBox, fmtDate } from '@/components/common';
import { EntryDialog } from '@/components/EntryDialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';

const TYPE: Record<string, string> = { asset: 'Activo', liability: 'Pasivo', equity: 'Patrimonio', revenue: 'Ingreso', expense: 'Gasto' };

// Cuenta contable con su historial de partidas (más recientes primero)
export function Account() {
  const { ref = '' } = useParams();
  const { byId } = useAssets();
  const [entryId, setEntryId] = useState<string | null>(null);
  const acc = useQuery({ queryKey: ['account', ref], queryFn: () => api<TAccount>(`/accounts/${encodeURIComponent(ref)}`) });
  const postings = useInfiniteQuery({
    queryKey: ['postings', ref],
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) => api<{ postings: AccountPosting[]; next_before: string | null }>(
      `/accounts/${encodeURIComponent(ref)}/postings?limit=50${pageParam ? `&before=${pageParam}` : ''}`),
    getNextPageParam: (last) => (last.postings.length === 50 ? last.next_before : null),
    enabled: !!acc.data,
  });

  if (acc.isPending) return <div className="mx-auto grid max-w-7xl gap-4"><Skeleton className="h-24" /><Skeleton className="h-64" /></div>;
  if (acc.error || !acc.data) return <div className="mx-auto max-w-7xl"><ErrorBox error={acc.error ?? 'No encontrada'} /></div>;
  const a = acc.data;
  const asset = byId(a.asset_id);
  const rows = postings.data?.pages.flatMap((p) => p.postings) ?? [];

  return (
    <div className="mx-auto grid max-w-7xl grid-cols-[minmax(0,1fr)] gap-6">
      {a.client_id
        ? <Link to={`/clientes/${a.client_id}`} className="inline-flex w-fit items-center gap-1 text-sm text-muted-foreground hover:text-foreground"><ArrowLeft className="size-4" />Cliente</Link>
        : <Link to="/" className="inline-flex w-fit items-center gap-1 text-sm text-muted-foreground hover:text-foreground"><ArrowLeft className="size-4" />Tablero</Link>}
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-xl font-semibold tracking-tight">{a.name}</h1>
            <Badge variant="outline">{TYPE[a.type] ?? a.type}</Badge>
            {!a.client_id && <Badge variant="secondary">Sistema</Badge>}
          </div>
          <div className="mt-1 flex items-center gap-1 font-mono text-xs text-muted-foreground"><span className="truncate">{a.code}</span><CopyButton value={a.code} /></div>
        </div>
        <div className="text-right">
          <div className="text-xs text-muted-foreground">Saldo ({a.normal_side === 'credit' ? 'lado crédito' : 'lado débito'})</div>
          <Amount v={a.balance} asset={asset} className="text-2xl font-semibold" />
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Movimientos</CardTitle>
          <CardDescription>Partidas de esta cuenta; el libro es inmutable (las correcciones son asientos de reverso).</CardDescription>
        </CardHeader>
        <CardContent>
          <ErrorBox error={postings.error} />
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Fecha</TableHead>
                <TableHead>Tipo</TableHead>
                <TableHead>Referencia</TableHead>
                <TableHead className="text-right">Débito</TableHead>
                <TableHead className="text-right">Crédito</TableHead>
                <TableHead className="text-right">Saldo</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {postings.isPending && <TableRow><TableCell colSpan={6}><Skeleton className="h-6" /></TableCell></TableRow>}
              {!postings.isPending && rows.length === 0 && <TableRow><TableCell colSpan={6} className="py-6 text-center text-muted-foreground">Sin movimientos</TableCell></TableRow>}
              {rows.map((p) => (
                <TableRow key={p.id} className="cursor-pointer" onClick={() => setEntryId(p.entry_id)}>
                  <TableCell className="num text-muted-foreground">{fmtDate(p.created_at)}</TableCell>
                  <TableCell><Badge variant="outline">{ENTRY_KIND[p.kind] ?? p.kind}</Badge></TableCell>
                  <TableCell className="max-w-64 truncate font-mono text-xs" title={p.external_ref ?? undefined}>{p.external_ref ?? '—'}</TableCell>
                  <TableCell className="text-right">{p.direction === 'debit' ? <Amount v={p.amount} asset={asset} symbol={false} /> : ''}</TableCell>
                  <TableCell className="text-right">{p.direction === 'credit' ? <Amount v={p.amount} asset={asset} symbol={false} /> : ''}</TableCell>
                  <TableCell className="text-right"><Amount v={p.balance_after} asset={asset} symbol={false} /></TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          {postings.hasNextPage && (
            <div className="flex justify-center py-3">
              <Button variant="outline" size="sm" onClick={() => postings.fetchNextPage()} disabled={postings.isFetchingNextPage}>
                {postings.isFetchingNextPage && <Loader2 className="animate-spin" />}Cargar más
              </Button>
            </div>
          )}
        </CardContent>
      </Card>
      <EntryDialog id={entryId} onClose={() => setEntryId(null)} />
    </div>
  );
}
