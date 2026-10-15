import { useEffect, useMemo, useState } from 'react';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ExternalLink, Loader2, Plus, QrCode } from 'lucide-react';
import { explorerFor, netLabel, papi, type DepositAddress, type DepositRow, type MyAsset } from '../api';
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
      {src ? <img src={src} alt={`Código QR de ${text.replace(/^ethereum:/, '').replace(/@\d+$/, '')}`} width={size} height={size} /> : <QrCode className="size-8 text-muted-foreground" />}
    </div>
  );
}

const STATUS: Record<DepositRow['status'], { t: string; v: 'warning' | 'success' | 'destructive' }> = {
  pending: { t: 'Pendiente', v: 'warning' }, held: { t: 'En revisión', v: 'warning' }, credited: { t: 'Acreditado', v: 'success' }, orphaned: { t: 'Descartado', v: 'destructive' },
};

export function Deposits() {
  const { me } = usePortal();
  const qc = useQueryClient();
  const canGenerate = !!me && me.user.role !== 'viewer';
  const [confirm, setConfirm] = useState(false);
  const [status, setStatus] = useState<'' | DepositRow['status']>('');
  const [network, setNetwork] = useState('');
  const addrs = useQuery({ queryKey: ['p-addresses'], queryFn: () => papi<{ addresses: DepositAddress[] }>('/deposit-addresses') });
  const assets = useQuery({ queryKey: ['p-assets'], queryFn: () => papi<{ assets: MyAsset[] }>('/assets').then((r) => r.assets) });
  // Redes donde puede recibir: encendidas y con al menos un activo habilitado (no «solo salida»)
  const receivable = useMemo(() => {
    const m = new Map<string, { label: string; symbols: string[] }>();
    for (const a of assets.data ?? []) {
      if (a.status !== 'enabled' || !a.network_enabled) continue;
      const e = m.get(a.network) ?? { label: a.network_label, symbols: [] };
      e.symbols.push(a.symbol); m.set(a.network, e);
    }
    return m;
  }, [assets.data]);
  const target = network || [...receivable.keys()][0] || '';
  const gen = useMutation({
    mutationFn: () => papi<DepositAddress>('/deposit-addresses', { method: 'POST', json: target ? { network: target } : {} }),
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
          <CardDescription>Exclusivas de su empresa, una por red. Todas siguen acreditando aunque genere una nueva.</CardDescription>
          {canGenerate && <CardAction><Button size="sm" onClick={() => setConfirm(true)}><Plus />Generar nueva dirección</Button></CardAction>}
        </CardHeader>
        <CardContent className="grid gap-3">
          <ErrorBox error={addrs.error} />
          {addrs.isPending && <Skeleton className="h-36" />}
          {addrs.data && !list.length && <p className="text-sm text-muted-foreground">{canGenerate ? 'Aún no tiene direcciones. Genere la primera.' : 'Aún no hay direcciones. Pida a un operador o administrador de su empresa que genere una.'}</p>}
          {list.map((w, i) => {
            const syms = receivable.get(w.network)?.symbols;
            const newest = list.findIndex((x) => x.network === w.network) === i;
            return (
            <div key={w.id} data-address={w.address} className="flex flex-col gap-3 rounded-md border p-3 sm:flex-row sm:items-center">
              <Qr text={w.uri} />
              <div className="grid min-w-0 gap-1.5">
                <div className="flex flex-wrap items-center gap-2 text-sm">
                  <Badge variant="outline" data-testid="address-network">{w.network_label ?? netLabel(w.network)}</Badge>
                  {newest && <Badge variant="success">Más reciente</Badge>}
                  <span className="text-xs text-muted-foreground">Creada {fmtDate(w.created_at)}</span>
                </div>
                <div className="flex items-center gap-1">
                  <code className="min-w-0 break-all font-mono text-sm">{w.address}</code>
                  <CopyButton value={w.address} />
                </div>
                <a className="inline-flex w-fit items-center gap-1 text-xs text-muted-foreground hover:underline" href={`${explorerFor(w.network, w.explorer)}/address/${w.address}`} target="_blank" rel="noreferrer noopener">
                  Ver en el explorador<ExternalLink className="size-3" /></a>
                <div className="text-xs text-muted-foreground">
                  {syms?.length ? <>Recibe: <b className="text-foreground">{syms.join(', ')}</b></> : 'Sin activos habilitados para recibir en esta red.'}
                </div>
              </div>
            </div>
            );
          })}
          <p className="text-xs text-muted-foreground">Envíe solo activos habilitados y por la red indicada. Un activo no habilitado queda en revisión; un envío por otra red no se puede recuperar.</p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Depósitos recibidos</CardTitle>
          <CardDescription>Se actualiza cada 30 segundos.</CardDescription>
          <CardAction>
            <Select aria-label="Filtrar por estado" className="h-8 w-40" value={status} onChange={(e) => setStatus(e.target.value as typeof status)}>
              <option value="">Todos</option><option value="pending">Pendientes</option><option value="held">En revisión</option><option value="credited">Acreditados</option><option value="orphaned">Descartados</option>
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
                <TableHeader><TableRow><TableHead>Fecha</TableHead><TableHead>Red</TableHead><TableHead>Estado</TableHead><TableHead className="text-right">Monto</TableHead><TableHead>Transacción</TableHead><TableHead>A la dirección</TableHead></TableRow></TableHeader>
                <TableBody>
                  {rows.map((d) => {
                    const s = STATUS[d.status];
                    const net = d.network ?? list.find((w) => w.address.toLowerCase() === d.to_address.toLowerCase())?.network ?? 'eth-sepolia';
                    return (
                      <TableRow key={d.id} data-deposit={d.tx_hash}>
                        <TableCell className="text-xs whitespace-nowrap text-muted-foreground">{fmtDate(d.created_at)}</TableCell>
                        <TableCell className="text-xs whitespace-nowrap">{d.network_label ?? netLabel(net)}</TableCell>
                        <TableCell>
                          <Badge variant={s.v}>{s.t}</Badge>
                          {d.status === 'pending' && <span className="ml-2 text-xs text-muted-foreground">{d.confirmations ?? 0}/{d.required_confirmations} confirmaciones</span>}
                          {d.status === 'held' && <span className="ml-2 text-xs text-muted-foreground">Activo no habilitado: 856 lo revisa antes de acreditarlo</span>}
                        </TableCell>
                        <TableCell className="text-right"><Money v={d.amount} decimals={d.decimals} symbol={d.symbol} /></TableCell>
                        <TableCell><a className="inline-flex items-center gap-1 font-mono text-xs hover:underline" href={`${explorerFor(net, d.explorer)}/tx/${d.tx_hash}`} target="_blank" rel="noreferrer noopener" title={d.tx_hash}>{shortHex(d.tx_hash, 8)}<ExternalLink className="size-3" /></a></TableCell>
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
            <DialogDescription>Se crea una dirección más para su empresa en la red elegida. Las anteriores siguen recibiendo y acreditando depósitos; puede seguir usándolas.</DialogDescription>
          </DialogHeader>
          {receivable.size > 0 ? (
            <label className="grid gap-1.5 text-sm">
              <span className="font-medium">Red</span>
              <Select aria-label="Red de la dirección" value={target} onChange={(e) => setNetwork(e.target.value)}>
                {[...receivable.entries()].map(([id, e]) => <option key={id} value={id}>{e.label} — {e.symbols.join(', ')}</option>)}
              </Select>
            </label>
          ) : assets.data && <p className="text-sm text-muted-foreground">Su empresa no tiene activos habilitados para recibir. Contacte a 856.</p>}
          <ErrorBox error={gen.error} />
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirm(false)}>Cancelar</Button>
            <Button onClick={() => gen.mutate()} disabled={gen.isPending || (!!assets.data && !receivable.size)}>{gen.isPending && <Loader2 className="animate-spin" />}Generar</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
