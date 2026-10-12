import { useState, type FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Cog, ExternalLink, FileSearch, Loader2, Plus, X } from 'lucide-react';
import {
  api, type ClientDetail, type DepositRow, type DepositStatus, type Summary, type SweepRow, type SweepStatus,
  type WithdrawalRow, type WithdrawalStatus,
} from '@/lib/api';
import { ago, shortHex } from '@/lib/amount';
import { useAuth } from '@/lib/auth';
import { useAssets } from '@/lib/hooks';
import { Amount, ErrorBox, Field, fmtDate } from '@/components/common';
import { EntryDialog } from '@/components/EntryDialog';
import { NewWithdrawalDialog, WD_STATUS, WithdrawalDialog } from '@/components/WithdrawalDialogs';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Tabs } from '@/components/ui/tabs';

type Tab = 'retiros' | 'depositos' | 'barridos';
const DEP_STATUS: Record<DepositStatus, { label: string; variant: 'warning' | 'success' | 'destructive' }> = {
  pending: { label: 'Pendiente', variant: 'warning' }, credited: { label: 'Acreditado', variant: 'success' }, orphaned: { label: 'Huérfano', variant: 'destructive' },
};
const SW_STATUS: Record<SweepStatus, { label: string; variant: 'warning' | 'default' | 'success' | 'destructive' }> = {
  signed: { label: 'Firmado', variant: 'warning' }, broadcast: { label: 'Enviado', variant: 'default' }, confirmed: { label: 'Confirmado', variant: 'success' }, failed: { label: 'Fallido', variant: 'destructive' },
};
const SW_KIND = { gas_topup: 'Gas a depósito', sweep_token: 'Barrido token', sweep_native: 'Barrido nativo' } as const;

function useList<T>(key: string, path: string, params: Record<string, string | undefined>, field: string) {
  return useInfiniteQuery({
    queryKey: [key, params],
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) => {
      const p = new URLSearchParams({ limit: '50' });
      Object.entries(params).forEach(([k, v]) => v && p.set(k, v));
      if (pageParam) p.set('cursor', pageParam);
      return api<Record<string, unknown> & { next_cursor: string | null }>(`${path}?${p}`).then((r) => ({ items: r[field] as T[], next: r.next_cursor }));
    },
    getNextPageParam: (last) => last.next,
    refetchInterval: 15_000,
  });
}

export function Movements() {
  const { can } = useAuth();
  const qc = useQueryClient();
  const [sp, setSp] = useSearchParams();
  const tab = (sp.get('tab') as Tab) || 'retiros';
  const clientId = sp.get('client_id');
  const status = sp.get('status') ?? '';
  const set = (k: string, v: string | null) => { const n = new URLSearchParams(sp); if (v) n.set(k, v); else n.delete(k); if (k === 'tab') n.delete('status'); setSp(n, { replace: true }); };

  const summary = useQuery({ queryKey: ['summary'], queryFn: () => api<Summary>('/summary'), refetchInterval: 15_000 });
  const explorer = summary.data?.explorer ?? 'https://sepolia.etherscan.io';
  const client = useQuery({ queryKey: ['client', clientId], queryFn: () => api<ClientDetail>(`/clients/${clientId}`), enabled: !!clientId });

  const [wdId, setWdId] = useState<string | null>(null);
  const [newWd, setNewWd] = useState(false);
  const [report, setReport] = useState(false);
  const [tickOpen, setTickOpen] = useState(false);

  return (
    <div className="mx-auto grid max-w-7xl grid-cols-[minmax(0,1fr)] gap-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Retiros, depósitos y barridos</h1>
          <p className="text-sm text-muted-foreground">Movimientos on-chain de la plataforma. Se actualiza cada 15 s.</p>
        </div>
        <div className="flex flex-wrap gap-2">
          {can('tesorero') && <Button variant="outline" onClick={() => setTickOpen(true)}><Cog />Ciclo del worker</Button>}
          {can('operador') && <Button variant="outline" onClick={() => setReport(true)}><FileSearch />Reportar depósito</Button>}
          {can('tesorero') && <Button onClick={() => setNewWd(true)}><Plus />Nuevo retiro</Button>}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <Tabs<Tab> value={tab} onChange={(v) => set('tab', v)} items={[
          { value: 'retiros', label: 'Retiros', count: summary.data?.withdrawals_in_flight.total },
          { value: 'depositos', label: 'Depósitos', count: summary.data?.deposits_pending },
          { value: 'barridos', label: 'Barridos', count: summary.data?.sweeps_open },
        ]} />
        {tab !== 'barridos' && (
          <Select aria-label="Estado" className="h-9 w-48" value={status} onChange={(e) => set('status', e.target.value || null)}>
            <option value="">Todos los estados</option>
            {Object.entries(tab === 'retiros' ? WD_STATUS : DEP_STATUS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
          </Select>
        )}
        {tab === 'barridos' && (
          <Select aria-label="Estado" className="h-9 w-48" value={status} onChange={(e) => set('status', e.target.value || null)}>
            <option value="">Todos los estados</option>
            {Object.entries(SW_STATUS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
          </Select>
        )}
        {clientId && tab !== 'barridos' && (
          <Badge variant="secondary" className="h-7 gap-1.5 px-2.5 text-sm">
            Cliente: {client.data?.name ?? clientId.slice(0, 8)}
            <button type="button" aria-label="Quitar filtro de cliente" onClick={() => set('client_id', null)}><X className="size-3.5" /></button>
          </Badge>
        )}
      </div>

      {tab === 'retiros' && <WithdrawalsTable clientId={clientId} status={status as WithdrawalStatus | ''} explorer={explorer} onOpen={setWdId} />}
      {tab === 'depositos' && <DepositsTable clientId={clientId} status={status as DepositStatus | ''} explorer={explorer} />}
      {tab === 'barridos' && <SweepsTable status={status as SweepStatus | ''} explorer={explorer} />}

      <WithdrawalDialog id={wdId} explorer={explorer} onClose={() => setWdId(null)} />
      <NewWithdrawalDialog open={newWd} onOpenChange={setNewWd} presetClientId={clientId} onCreated={(id) => { set('tab', 'retiros'); setWdId(id); }} />
      <ReportDepositDialog open={report} onOpenChange={setReport} explorer={explorer} onDone={() => { qc.invalidateQueries({ queryKey: ['deposits'] }); set('tab', 'depositos'); }} />
      <WorkerTickDialog open={tickOpen} onOpenChange={setTickOpen} />
    </div>
  );
}

function LoadMore({ q }: { q: { hasNextPage: boolean; isFetchingNextPage: boolean; fetchNextPage: () => unknown } }) {
  if (!q.hasNextPage) return null;
  return (
    <div className="flex justify-center py-3">
      <Button variant="outline" size="sm" onClick={() => q.fetchNextPage()} disabled={q.isFetchingNextPage}>{q.isFetchingNextPage && <Loader2 className="animate-spin" />}Cargar más</Button>
    </div>
  );
}

function TxLink({ explorer, hash }: { explorer: string; hash: string | null }) {
  if (!hash) return <span className="text-xs text-muted-foreground">—</span>;
  return <a className="inline-flex items-center gap-1 font-mono text-xs hover:underline" href={`${explorer}/tx/${hash}`} target="_blank" rel="noreferrer noopener" onClick={(e) => e.stopPropagation()}>{shortHex(hash)}<ExternalLink className="size-3" /></a>;
}

function WithdrawalsTable({ clientId, status, explorer, onOpen }: { clientId: string | null; status: WithdrawalStatus | ''; explorer: string; onOpen: (id: string) => void }) {
  const { byId } = useAssets();
  const q = useList<WithdrawalRow>('withdrawals', '/withdrawals', { client_id: clientId ?? undefined, status: status || undefined }, 'withdrawals');
  const rows = q.data?.pages.flatMap((p) => p.items) ?? [];
  return (
    <Card className="py-2"><CardContent className="px-3">
      <ErrorBox error={q.error} />
      <Table>
        <TableHeader><TableRow>
          <TableHead>Estado</TableHead><TableHead>Cliente</TableHead><TableHead className="text-right">Monto</TableHead>
          <TableHead>Destino</TableHead><TableHead>Tx</TableHead><TableHead className="text-right">Conf.</TableHead><TableHead className="text-right">Creado</TableHead>
        </TableRow></TableHeader>
        <TableBody>
          {q.isPending && <TableRow><TableCell colSpan={7}><Skeleton className="h-6" /></TableCell></TableRow>}
          {!q.isPending && rows.length === 0 && <TableRow><TableCell colSpan={7} className="py-8 text-center text-muted-foreground">Sin retiros</TableCell></TableRow>}
          {rows.map((w) => (
            <TableRow key={w.id} className="cursor-pointer" onClick={() => onOpen(w.id)}>
              <TableCell>
                <Badge variant={WD_STATUS[w.status].variant}>{WD_STATUS[w.status].label}</Badge>
                {w.last_error && ['reserved', 'signed', 'broadcast'].includes(w.status) && <div className="mt-1 max-w-48 truncate text-[11px] text-destructive" title={w.last_error}>{w.last_error}</div>}
              </TableCell>
              <TableCell><Link to={`/clientes/${w.client_id}`} onClick={(e) => e.stopPropagation()} className="block max-w-48 truncate font-medium hover:underline">{w.client_name}</Link></TableCell>
              <TableCell className="text-right"><Amount v={w.amount} asset={byId(w.asset_id)} /></TableCell>
              <TableCell className="font-mono text-xs" title={w.to_address}>{shortHex(w.to_address)}</TableCell>
              <TableCell><TxLink explorer={explorer} hash={w.tx_hash} /></TableCell>
              <TableCell className="num text-right">{w.confirmations}</TableCell>
              <TableCell className="num text-right text-muted-foreground" title={fmtDate(w.created_at)}>{ago(w.created_at)}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      <LoadMore q={q} />
    </CardContent></Card>
  );
}

function DepositsTable({ clientId, status, explorer }: { clientId: string | null; status: DepositStatus | ''; explorer: string }) {
  const { byId } = useAssets();
  const [entryId, setEntryId] = useState<string | null>(null);
  const q = useList<DepositRow>('deposits', '/deposits', { client_id: clientId ?? undefined, status: status || undefined }, 'deposits');
  const rows = q.data?.pages.flatMap((p) => p.items) ?? [];
  return (
    <Card className="py-2"><CardContent className="px-3">
      <ErrorBox error={q.error} />
      <Table>
        <TableHeader><TableRow>
          <TableHead>Estado</TableHead><TableHead>Cliente</TableHead><TableHead className="text-right">Monto</TableHead>
          <TableHead>Tx</TableHead><TableHead>Origen</TableHead><TableHead className="text-right">Conf.</TableHead><TableHead className="text-right">Detectado</TableHead>
        </TableRow></TableHeader>
        <TableBody>
          {q.isPending && <TableRow><TableCell colSpan={7}><Skeleton className="h-6" /></TableCell></TableRow>}
          {!q.isPending && rows.length === 0 && <TableRow><TableCell colSpan={7} className="py-8 text-center text-muted-foreground">Sin depósitos</TableCell></TableRow>}
          {rows.map((d) => (
            <TableRow key={d.id} className={d.entry_id ? 'cursor-pointer' : undefined} onClick={() => d.entry_id && setEntryId(d.entry_id)}>
              <TableCell><Badge variant={DEP_STATUS[d.status].variant}>{DEP_STATUS[d.status].label}</Badge></TableCell>
              <TableCell><Link to={`/clientes/${d.client_id}`} onClick={(e) => e.stopPropagation()} className="block max-w-48 truncate font-medium hover:underline">{d.client_name}</Link></TableCell>
              <TableCell className="text-right"><Amount v={d.amount} asset={byId(d.asset_id)} /></TableCell>
              <TableCell><TxLink explorer={explorer} hash={d.tx_hash} /></TableCell>
              <TableCell><Badge variant="outline">{d.source === 'webhook' ? 'Webhook' : 'Reporte'}</Badge></TableCell>
              <TableCell className="num text-right">{d.confirmations}</TableCell>
              <TableCell className="num text-right text-muted-foreground" title={fmtDate(d.created_at)}>{ago(d.created_at)}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      <LoadMore q={q} />
      <EntryDialog id={entryId} onClose={() => setEntryId(null)} />
    </CardContent></Card>
  );
}

function SweepsTable({ status, explorer }: { status: SweepStatus | ''; explorer: string }) {
  const { byId } = useAssets();
  const q = useList<SweepRow>('sweeps', '/sweeps', { status: status || undefined }, 'sweeps');
  const rows = q.data?.pages.flatMap((p) => p.items) ?? [];
  return (
    <Card className="py-2"><CardContent className="px-3">
      <ErrorBox error={q.error} />
      <Table>
        <TableHeader><TableRow>
          <TableHead>Estado</TableHead><TableHead>Tipo</TableHead><TableHead>Cliente</TableHead><TableHead className="text-right">Monto</TableHead>
          <TableHead>De → a</TableHead><TableHead>Tx</TableHead><TableHead className="text-right">Gas</TableHead><TableHead className="text-right">Creado</TableHead>
        </TableRow></TableHeader>
        <TableBody>
          {q.isPending && <TableRow><TableCell colSpan={8}><Skeleton className="h-6" /></TableCell></TableRow>}
          {!q.isPending && rows.length === 0 && <TableRow><TableCell colSpan={8} className="py-8 text-center text-muted-foreground">Sin barridos</TableCell></TableRow>}
          {rows.map((s) => (
            <TableRow key={s.id}>
              <TableCell><Badge variant={SW_STATUS[s.status].variant}>{SW_STATUS[s.status].label}</Badge>
                {s.last_error && <div className="mt-1 max-w-48 truncate text-[11px] text-destructive" title={s.last_error}>{s.last_error}</div>}</TableCell>
              <TableCell>{SW_KIND[s.kind]}</TableCell>
              <TableCell>{s.client_id ? <Link to={`/clientes/${s.client_id}`} className="block max-w-40 truncate hover:underline">{s.client_name}</Link> : '—'}</TableCell>
              <TableCell className="text-right"><Amount v={s.amount} asset={byId(s.asset_id)} /></TableCell>
              <TableCell className="font-mono text-xs"><span title={s.from_address}>{shortHex(s.from_address, 4)}</span> → <span title={s.to_address}>{shortHex(s.to_address, 4)}</span></TableCell>
              <TableCell><TxLink explorer={explorer} hash={s.tx_hash} /></TableCell>
              <TableCell className="text-right">{s.gas_cost_wei ? <Amount v={s.gas_cost_wei} asset={byId('ETH-SEPOLIA')} /> : '—'}</TableCell>
              <TableCell className="num text-right text-muted-foreground" title={fmtDate(s.created_at)}>{ago(s.created_at)}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      <LoadMore q={q} />
    </CardContent></Card>
  );
}

function ReportDepositDialog({ open, onOpenChange, explorer, onDone }: { open: boolean; onOpenChange: (v: boolean) => void; explorer: string; onDone: () => void }) {
  const { byId } = useAssets();
  const [hash, setHash] = useState('');
  const m = useMutation({
    mutationFn: () => api<{ tx_hash: string; deposits: DepositRow[]; required_confirmations: number }>('/deposits/report', { method: 'POST', json: { tx_hash: hash.trim() } }),
    onSuccess: onDone,
  });
  const valid = /^0x[0-9a-fA-F]{64}$/.test(hash.trim());
  return (
    <Dialog open={open} onOpenChange={(v) => { onOpenChange(v); if (!v) { setHash(''); m.reset(); } }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Reportar depósito por hash</DialogTitle>
          <DialogDescription>Revalida la transacción contra la cadena y registra los depósitos a direcciones de clientes. Se acreditan al alcanzar las confirmaciones requeridas.</DialogDescription>
        </DialogHeader>
        <form className="grid gap-4" onSubmit={(e: FormEvent) => { e.preventDefault(); m.mutate(); }}>
          <Field label="Hash de la transacción" htmlFor="rd-hash">
            <Input id="rd-hash" autoFocus className="font-mono text-xs" placeholder="0x… (64 hex)" value={hash} onChange={(e) => setHash(e.target.value)} aria-invalid={hash !== '' && !valid} />
          </Field>
          <ErrorBox error={m.error} />
          {m.data && (
            <div className="rounded-md border p-3 text-sm">
              {m.data.deposits.length === 0
                ? <p>La transacción no envía fondos a ninguna dirección de depósito de un cliente.</p>
                : m.data.deposits.map((d) => (
                  <div key={d.id} className="flex flex-wrap items-center gap-2">
                    <Badge variant={DEP_STATUS[d.status].variant}>{DEP_STATUS[d.status].label}</Badge>
                    <Amount v={d.amount} asset={byId(d.asset_id)} /><span className="text-muted-foreground">· {d.confirmations}/{m.data.required_confirmations} conf.</span>
                  </div>
                ))}
              <a className="mt-2 inline-flex items-center gap-1 text-xs hover:underline" href={`${explorer}/tx/${m.data.tx_hash}`} target="_blank" rel="noreferrer noopener">Ver en el explorador<ExternalLink className="size-3" /></a>
            </div>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>Cerrar</Button>
            <Button type="submit" disabled={!valid || m.isPending}>{m.isPending && <Loader2 className="animate-spin" />}Reportar</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function WorkerTickDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void }) {
  const qc = useQueryClient();
  const m = useMutation({
    mutationFn: () => api<unknown>('/worker/tick', { method: 'POST', json: {} }),
    onSuccess: () => ['withdrawals', 'deposits', 'sweeps', 'summary'].forEach((k) => qc.invalidateQueries({ queryKey: [k] })),
  });
  return (
    <Dialog open={open} onOpenChange={(v) => { onOpenChange(v); if (!v) m.reset(); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Ejecutar un ciclo del worker</DialogTitle>
          <DialogDescription>Firma y envía retiros reservados, actualiza confirmaciones, acredita depósitos, registra direcciones en el webhook y ejecuta barridos. El worker ya corre solo cada pocos segundos; úselo solo para forzar un ciclo.</DialogDescription>
        </DialogHeader>
        <ErrorBox error={m.error} />
        {m.isSuccess && <pre className="max-h-48 overflow-auto rounded bg-muted p-2 text-xs">{JSON.stringify(m.data, null, 2)}</pre>}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cerrar</Button>
          <Button onClick={() => m.mutate()} disabled={m.isPending}>{m.isPending && <Loader2 className="animate-spin" />}Ejecutar</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
