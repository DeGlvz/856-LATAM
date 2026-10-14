import { useEffect, useState } from 'react';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ExternalLink, Loader2, Plus, QrCode } from 'lucide-react';
import { explorerFor, papi, type DepositAddress, type DepositRow } from '../api';
import { usePortal } from '../auth';
import { Money } from '../money';
import { CopyButton, ErrorBox, fmtDate } from '@/components/common';
import { shortHex } from '@/lib/amount';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Select } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';

function Qr({ text, size = 132 }: { text: string; size?: number }) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    import('qrcode').then((m) => m.default.toDataURL(text, { margin: 1, width: size })).then((u) => live && setSrc(u), () => live && setSrc(null));
    return () => { live = false; };
  }, [text, size]);
  return (
    <div className="grid shrink-0 place-items-center rounded-md border bg-white p-1" style={{ width: size + 10, height: size + 10 }}>
      {src ? <img src={src} alt={`Código QR de ${text.replace(/^ethereum:/, '')}`} width={size} height={size} /> : <QrCode className="size-8 text-muted-foreground" />}
    </div>
  );
}

const STATUS: Record<DepositRow['status'], { t: string; v: 'warning' | 'success' | 'destructive' }> = {
  pending: { t: 'Pendiente', v: 'warning' }, credited: { t: 'Acreditado', v: 'success' }, orphaned: { t: 'Descartado', v: 'destructive' },
};

export function Deposits() {
  const { me } = usePortal();
  const qc = useQueryClient();
  const canGenerate = !!me && me.user.role !== 'viewer';
  const [confirm, setConfirm] = useState(false);
  const [status, setStatus] = useState<'' | DepositRow['status']>('');
  const addrs = useQuery({ queryKey: ['p-addresses'], queryFn: () => papi<{ addresses: DepositAddress[] }>('/deposit-addresses') });
  const gen = useMutation({
    mutationFn: () => papi<DepositAddress>('/deposit-addresses', { method: 'POST', json: {} }),
    onSuccess: () => { setConfirm(false); qc.invalidateQueries({ queryKey: ['p-addresses'] }); qc.invalidateQueries({ queryKey: ['p-notices'] }); },
  });
  const deps = useInfiniteQuery({
    queryKey: ['p-deposits', status],
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) => {
      const p = new URLSearchParams({ limit: '50' });
      if (status) p.set('status', status);
      if (pageParam) p.set('cursor', pageParam);
      return papi<{ deposits: DepositRow[]; next_cursor: string | null }>(`/deposits?${p}`);
    },
    getNextPageParam: (l) => l.next_cursor,
    refetchInterval: 30_000,
  });
  const list = addrs.data?.addresses ?? [];
  const rows = deps.data?.pages.flatMap((p) => p.deposits) ?? [];

  return (
    <div className="mx-auto grid max-w-6xl grid-cols-[minmax(0,1fr)] gap-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Depósitos</h1>
        <p className="text-sm text-muted-foreground">Envíe fondos a una de sus direcciones. Se acreditan a su saldo al alcanzar las confirmaciones requeridas.</p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Direcciones de depósito</CardTitle>
          <CardDescription>Exclusivas de su empresa. Todas siguen acreditando aunque genere una nueva.</CardDescription>
          {canGenerate && <CardAction><Button size="sm" onClick={() => setConfirm(true)}><Plus />Generar nueva dirección</Button></CardAction>}
        </CardHeader>
        <CardContent className="grid gap-3">
          <ErrorBox error={addrs.error} />
          {addrs.isPending && <Skeleton className="h-36" />}
          {addrs.data && !list.length && <p className="text-sm text-muted-foreground">{canGenerate ? 'Aún no tiene direcciones. Genere la primera.' : 'Aún no hay direcciones. Pida a un operador o administrador de su empresa que genere una.'}</p>}
          {list.map((w, i) => (
            <div key={w.id} data-address={w.address} className="flex flex-col gap-3 rounded-md border p-3 sm:flex-row sm:items-center">
              <Qr text={w.uri} />
              <div className="grid min-w-0 gap-1.5">
                <div className="flex flex-wrap items-center gap-2 text-sm">
                  {i === 0 && <Badge variant="success">Más reciente</Badge>}
                  <Badge variant="outline" className="font-mono">{w.network}</Badge>
                  <span className="text-xs text-muted-foreground">Creada {fmtDate(w.created_at)}</span>
                </div>
                <div className="flex items-center gap-1">
                  <code className="min-w-0 break-all font-mono text-sm">{w.address}</code>
                  <CopyButton value={w.address} />
                </div>
                <a className="inline-flex w-fit items-center gap-1 text-xs text-muted-foreground hover:underline" href={`${explorerFor(w.network)}/address/${w.address}`} target="_blank" rel="noreferrer noopener">
                  Ver en el explorador<ExternalLink className="size-3" /></a>
              </div>
            </div>
          ))}
          <p className="text-xs text-muted-foreground">Envíe solo activos de la red indicada. Un envío por otra red no se puede recuperar.</p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Depósitos recibidos</CardTitle>
          <CardDescription>Se actualiza cada 30 segundos.</CardDescription>
          <CardAction>
            <Select aria-label="Filtrar por estado" className="h-8 w-40" value={status} onChange={(e) => setStatus(e.target.value as typeof status)}>
              <option value="">Todos</option><option value="pending">Pendientes</option><option value="credited">Acreditados</option><option value="orphaned">Descartados</option>
            </Select>
          </CardAction>
        </CardHeader>
        <CardContent className="grid gap-3">
          <ErrorBox error={deps.error} />
          {deps.isPending && <Skeleton className="h-24" />}
          {deps.data && !rows.length && <p className="py-4 text-center text-sm text-muted-foreground">Sin depósitos{status ? ' con este estado' : ''}.</p>}
          {!!rows.length && (
            <div className="overflow-x-auto">
              <Table aria-label="Depósitos">
                <TableHeader><TableRow><TableHead>Fecha</TableHead><TableHead>Estado</TableHead><TableHead className="text-right">Monto</TableHead><TableHead>Transacción</TableHead><TableHead>A la dirección</TableHead></TableRow></TableHeader>
                <TableBody>
                  {rows.map((d) => {
                    const s = STATUS[d.status];
                    const net = list.find((w) => w.address.toLowerCase() === d.to_address.toLowerCase())?.network ?? 'eth-sepolia';
                    return (
                      <TableRow key={d.id} data-deposit={d.tx_hash}>
                        <TableCell className="text-xs whitespace-nowrap text-muted-foreground">{fmtDate(d.created_at)}</TableCell>
                        <TableCell>
                          <Badge variant={s.v}>{s.t}</Badge>
                          {d.status === 'pending' && <span className="ml-2 text-xs text-muted-foreground">{d.confirmations ?? 0}/{d.required_confirmations} confirmaciones</span>}
                        </TableCell>
                        <TableCell className="text-right"><Money v={d.amount} decimals={d.decimals} symbol={d.symbol} /></TableCell>
                        <TableCell><a className="inline-flex items-center gap-1 font-mono text-xs hover:underline" href={`${explorerFor(net)}/tx/${d.tx_hash}`} target="_blank" rel="noreferrer noopener" title={d.tx_hash}>{shortHex(d.tx_hash, 8)}<ExternalLink className="size-3" /></a></TableCell>
                        <TableCell className="font-mono text-xs" title={d.to_address}>{shortHex(d.to_address, 6)}</TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          )}
          {deps.hasNextPage && <div className="text-center"><Button variant="outline" size="sm" onClick={() => deps.fetchNextPage()} disabled={deps.isFetchingNextPage}>Cargar más</Button></div>}
        </CardContent>
      </Card>

      <Dialog open={confirm} onOpenChange={(o) => { setConfirm(o); if (!o) gen.reset(); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Generar nueva dirección</DialogTitle>
            <DialogDescription>Se crea una dirección más para su empresa. Las anteriores siguen recibiendo y acreditando depósitos; puede seguir usándolas.</DialogDescription>
          </DialogHeader>
          <ErrorBox error={gen.error} />
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirm(false)}>Cancelar</Button>
            <Button onClick={() => gen.mutate()} disabled={gen.isPending}>{gen.isPending && <Loader2 className="animate-spin" />}Generar</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
