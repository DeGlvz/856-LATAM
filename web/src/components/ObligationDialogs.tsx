import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Loader2, Plus, Search, X } from 'lucide-react';
import { api, newIdemKey, type ClientRow, type ObligationRow, type ObligationStatus } from '@/lib/api';
import { ago, parseUnits } from '@/lib/amount';
import { useAuth } from '@/lib/auth';
import { useAssets } from '@/lib/hooks';
import { Amount, CopyButton, ErrorBox, Field, fmtDate, StatusBadge } from '@/components/common';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Textarea } from '@/components/ui/textarea';

export const OB_STATUS: Record<ObligationStatus, { label: string; plural: string; variant: 'warning' | 'success' | 'outline' | 'secondary' | 'destructive' }> = {
  pending_acceptance: { label: 'Por aceptar', plural: 'Por aceptar', variant: 'secondary' },
  open: { label: 'Abierta', plural: 'Abiertas', variant: 'warning' }, settled: { label: 'Liquidada', plural: 'Liquidadas', variant: 'success' },
  cancelled: { label: 'Cancelada', plural: 'Canceladas', variant: 'outline' },
  rejected: { label: 'Rechazada', plural: 'Rechazadas', variant: 'destructive' }, expired: { label: 'Vencida', plural: 'Vencidas', variant: 'outline' },
};
const OB_KEYS = ['obligations', 'netting-preview', 'client'];

export function useObligations(params: Record<string, string | undefined>, opts: { refetch?: boolean } = {}) {
  return useInfiniteQuery({
    queryKey: ['obligations', params],
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) => {
      const p = new URLSearchParams({ limit: '50' });
      Object.entries(params).forEach(([k, v]) => v && p.set(k, v));
      if (pageParam) p.set('cursor', pageParam);
      return api<{ obligations: ObligationRow[]; next_cursor: string | null }>(`/obligations?${p}`);
    },
    getNextPageParam: (last) => last.next_cursor,
    refetchInterval: opts.refetch === false ? false : 30_000,
  });
}

/** Tabla de obligaciones. Con `selectable`, las abiertas se pueden marcar para simular solo esa selección. */
export function ObligationsTable({ params, perspective, selectable, selected, onToggle, onOpen }: {
  params: Record<string, string | undefined>; perspective?: string;
  selectable?: boolean; selected?: Set<string>; onToggle?: (o: ObligationRow) => void; onOpen: (o: ObligationRow) => void;
}) {
  const { byId } = useAssets();
  const q = useObligations(params);
  const rows = q.data?.pages.flatMap((p) => p.obligations) ?? [];
  const cols = selectable ? 8 : 7;
  return (
    <>
      <ErrorBox error={q.error} />
      <Table>
        <TableHeader><TableRow>
          {selectable && <TableHead className="w-8"><span className="sr-only">Seleccionar</span></TableHead>}
          <TableHead>Estado</TableHead><TableHead>Deudor → acreedor</TableHead><TableHead className="text-right">Monto</TableHead>
          <TableHead>Referencia</TableHead><TableHead>Vence</TableHead><TableHead>Activo</TableHead><TableHead className="text-right">Creada</TableHead>
        </TableRow></TableHeader>
        <TableBody>
          {q.isPending && <TableRow><TableCell colSpan={cols}><Skeleton className="h-6" /></TableCell></TableRow>}
          {!q.isPending && rows.length === 0 && <TableRow><TableCell colSpan={cols} className="py-8 text-center text-muted-foreground">Sin obligaciones</TableCell></TableRow>}
          {rows.map((o) => (
            <TableRow key={o.id} className="cursor-pointer" onClick={() => onOpen(o)} data-state={selected?.has(o.id) ? 'selected' : undefined}>
              {selectable && (
                <TableCell onClick={(e) => e.stopPropagation()}>
                  {o.status === 'open' && (
                    <input type="checkbox" aria-label={`Seleccionar obligación ${o.external_ref ?? o.id.slice(0, 8)}`} className="size-4 accent-primary"
                      checked={selected?.has(o.id) ?? false} onChange={() => onToggle?.(o)} />
                  )}
                </TableCell>
              )}
              <TableCell><Badge variant={OB_STATUS[o.status].variant}>{OB_STATUS[o.status].label}</Badge></TableCell>
              <TableCell className="max-w-72">
                <div className="flex items-center gap-1 truncate text-sm">
                  <Link to={`/clientes/${o.debtor_id}`} onClick={(e) => e.stopPropagation()} className={perspective === o.debtor_id ? 'font-semibold' : 'hover:underline'}>{o.debtor_name}</Link>
                  <span className="text-muted-foreground">→</span>
                  <Link to={`/clientes/${o.creditor_id}`} onClick={(e) => e.stopPropagation()} className={perspective === o.creditor_id ? 'font-semibold' : 'hover:underline'}>{o.creditor_name}</Link>
                </div>
                {perspective && <div className="text-[11px] text-muted-foreground">{perspective === o.debtor_id ? 'Por pagar' : 'Por cobrar'}</div>}
              </TableCell>
              <TableCell className="text-right"><Amount v={o.amount} asset={byId(o.asset_id)} /></TableCell>
              <TableCell className="max-w-40 truncate font-mono text-xs" title={o.external_ref ?? undefined}>{o.external_ref ?? '—'}</TableCell>
              <TableCell className="text-xs">{o.due_at ? fmtDate(o.due_at) : <span className="text-muted-foreground">Sin vencimiento</span>}</TableCell>
              <TableCell className="text-xs text-muted-foreground">{byId(o.asset_id).symbol}</TableCell>
              <TableCell className="num text-right text-muted-foreground" title={fmtDate(o.created_at)}>{ago(o.created_at)}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      {q.hasNextPage && (
        <div className="flex justify-center py-3">
          <Button variant="outline" size="sm" onClick={() => q.fetchNextPage()} disabled={q.isFetchingNextPage}>{q.isFetchingNextPage && <Loader2 className="animate-spin" />}Cargar más</Button>
        </div>
      )}
    </>
  );
}

// ───────────── Detalle y cancelación ─────────────
export function ObligationDialog({ obligation: o, onClose, onOpenRun }: { obligation: ObligationRow | null; onClose: () => void; onOpenRun?: (id: string) => void }) {
  const { can } = useAuth();
  const { byId } = useAssets();
  const qc = useQueryClient();
  const [reason, setReason] = useState('');
  const cancel = useMutation({
    mutationFn: () => api<ObligationRow>(`/obligations/${o!.id}/cancel`, { method: 'POST', json: { reason: reason.trim() } }),
    onSuccess: () => { OB_KEYS.forEach((k) => qc.invalidateQueries({ queryKey: [k] })); onClose(); },
  });
  useEffect(() => { setReason(''); cancel.reset(); }, [o?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!o) return null;
  const a = byId(o.asset_id);
  return (
    <Dialog open onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">Obligación <Badge variant={OB_STATUS[o.status].variant}>{OB_STATUS[o.status].label}</Badge></DialogTitle>
          <DialogDescription className="flex items-center gap-1 font-mono text-xs">{o.id}<CopyButton value={o.id} /></DialogDescription>
        </DialogHeader>
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-sm">
          <dt className="text-muted-foreground">Deudor</dt>
          <dd className="flex items-center gap-2"><Link to={`/clientes/${o.debtor_id}`} onClick={onClose} className="hover:underline">{o.debtor_name}</Link><StatusBadge status={o.debtor_status} /></dd>
          <dt className="text-muted-foreground">Acreedor</dt>
          <dd className="flex items-center gap-2"><Link to={`/clientes/${o.creditor_id}`} onClick={onClose} className="hover:underline">{o.creditor_name}</Link><StatusBadge status={o.creditor_status} /></dd>
          <dt className="text-muted-foreground">Monto</dt><dd><Amount v={o.amount} asset={a} exact /></dd>
          <dt className="text-muted-foreground">Referencia</dt><dd className="font-mono text-xs">{o.external_ref ?? '—'}</dd>
          <dt className="text-muted-foreground">Vence</dt><dd>{o.due_at ? fmtDate(o.due_at) : 'Sin vencimiento (entra en cualquier corte)'}</dd>
          <dt className="text-muted-foreground">Creada</dt><dd>{fmtDate(o.created_at)}</dd>
          {o.status === 'settled' && <><dt className="text-muted-foreground">Liquidada</dt><dd>{o.settled_at ? fmtDate(o.settled_at) : '—'}
            {o.netting_run_id && onOpenRun && <Button variant="link" size="sm" className="h-auto px-2" onClick={() => onOpenRun(o.netting_run_id!)}>Ver corrida</Button>}</dd></>}
          {o.status === 'pending_acceptance' && o.accept_due_at && <><dt className="text-muted-foreground">Aceptación</dt>
            <dd>El deudor debe aceptarla en su portal antes de {fmtDate(o.accept_due_at)}</dd></>}
          {o.accepted_at && <><dt className="text-muted-foreground">Aceptada</dt><dd>{fmtDate(o.accepted_at)}{o.accepted_by && <span className="text-muted-foreground"> · {o.accepted_by}</span>}</dd></>}
          {o.status === 'rejected' && <><dt className="text-muted-foreground">Rechazada</dt>
            <dd>{o.rejected_at ? fmtDate(o.rejected_at) : '—'}{o.rejected_by && <span className="text-muted-foreground"> · {o.rejected_by}</span>}
              {o.rejected_reason && <div className="text-muted-foreground">«{o.rejected_reason}»</div>}</dd></>}
          {o.created_by && <><dt className="text-muted-foreground">Registró</dt><dd>{o.created_by}</dd></>}
          {o.status === 'cancelled' && <><dt className="text-muted-foreground">Cancelada</dt>
            <dd>{o.cancelled_at ? fmtDate(o.cancelled_at) : '—'}{o.cancelled_by && <span className="text-muted-foreground"> · {o.cancelled_by}</span>}
              {o.cancel_reason && <div className="text-muted-foreground">«{o.cancel_reason}»</div>}</dd></>}
        </dl>
        {(o.status === 'open' || o.status === 'pending_acceptance') && can('ejecutivo') && (
          <form className="grid gap-2 rounded-md border border-destructive/30 p-3" onSubmit={(e: FormEvent) => { e.preventDefault(); cancel.mutate(); }}>
            <p className="text-sm">Al cancelarla sale de los siguientes cortes. No mueve saldo y queda en la bitácora con el motivo.</p>
            <Textarea aria-label="Motivo de cancelación" placeholder="Motivo (mín. 5 caracteres), p. ej. OC duplicada" maxLength={500} rows={2} value={reason} onChange={(e) => setReason(e.target.value)} />
            <ErrorBox error={cancel.error} />
            <div className="flex justify-end">
              <Button type="submit" variant="destructive" disabled={reason.trim().length < 5 || cancel.isPending}>{cancel.isPending && <Loader2 className="animate-spin" />}Cancelar obligación</Button>
            </div>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}

// ───────────── Selector de cliente (excluye cerrados) ─────────────
function ClientPicker({ label, value, onChange, exclude, autoFocus }: {
  label: string; value: ClientRow | null; onChange: (c: ClientRow | null) => void; exclude?: string; autoFocus?: boolean;
}) {
  const [search, setSearch] = useState('');
  const found = useQuery({
    queryKey: ['clients', { q: search, picker: 'obligation' }],
    queryFn: () => api<{ clients: ClientRow[] }>(`/clients?limit=10${search.trim() ? `&q=${encodeURIComponent(search.trim())}` : ''}`).then((r) => r.clients),
    enabled: !value,
  });
  if (value) {
    return (
      <Field label={label}>
        <div className="flex items-center justify-between rounded-md bg-muted px-3 py-2 text-sm">
          <span className="flex items-center gap-2 truncate"><b className="truncate">{value.name}</b><StatusBadge status={value.status} /></span>
          <Button type="button" variant="ghost" size="icon" className="size-7" aria-label={`Cambiar ${label.toLowerCase()}`} onClick={() => onChange(null)}><X /></Button>
        </div>
      </Field>
    );
  }
  const list = (found.data ?? []).filter((c) => c.status !== 'closed' && c.id !== exclude);
  return (
    <Field label={label}>
      <div className="relative">
        <Search className="pointer-events-none absolute top-2.5 left-2.5 size-4 text-muted-foreground" />
        <Input autoFocus={autoFocus} aria-label={`Buscar ${label.toLowerCase()}`} className="pl-8" placeholder="Nombre, ID externo o UUID" value={search} onChange={(e) => setSearch(e.target.value)} />
      </div>
      <div className="grid max-h-40 gap-1 overflow-y-auto">
        {found.isPending && <Skeleton className="h-9" />}
        {!found.isPending && list.length === 0 && <p className="py-2 text-center text-xs text-muted-foreground">Sin clientes</p>}
        {list.map((c) => (
          <button key={c.id} type="button" onClick={() => onChange(c)} className="flex items-center justify-between gap-2 rounded-md border px-3 py-1.5 text-left text-sm hover:bg-accent">
            <span className="truncate font-medium">{c.name}</span><StatusBadge status={c.status} />
          </button>
        ))}
      </div>
    </Field>
  );
}

// ───────────── Alta de obligación (operador) ─────────────
export function NewObligationDialog({ open, onOpenChange, presetAssetId }: { open: boolean; onOpenChange: (v: boolean) => void; presetAssetId?: string }) {
  const qc = useQueryClient();
  const { assets, byId } = useAssets();
  const [debtor, setDebtor] = useState<ClientRow | null>(null);
  const [creditor, setCreditor] = useState<ClientRow | null>(null);
  const [assetId, setAssetId] = useState('');
  const [amountText, setAmountText] = useState('');
  const [ref, setRef] = useState('');
  const [due, setDue] = useState('');
  const [key, setKey] = useState(newIdemKey);

  useEffect(() => {
    if (open) { setDebtor(null); setCreditor(null); setAssetId(presetAssetId ?? ''); setAmountText(''); setRef(''); setDue(''); setKey(newIdemKey()); }
  }, [open, presetAssetId]);
  useEffect(() => { if (!assetId && assets[0]) setAssetId(assets[0].id); }, [assets, assetId]);

  const asset = byId(assetId);
  const base = useMemo(() => (assetId ? parseUnits(amountText, asset.decimals) : null), [amountText, assetId, asset.decimals]);
  const ready = !!debtor && !!creditor && debtor.id !== creditor.id && !!assetId && base != null;

  const m = useMutation({
    mutationFn: () => api<ObligationRow>('/obligations', {
      method: 'POST', headers: { 'idempotency-key': key },
      json: {
        debtor_id: debtor!.id, creditor_id: creditor!.id, asset_id: assetId, amount: base,
        ...(ref.trim() ? { external_ref: ref.trim() } : {}), ...(due ? { due_at: new Date(due).toISOString() } : {}),
      },
    }),
    onSuccess: () => { OB_KEYS.forEach((k) => qc.invalidateQueries({ queryKey: [k] })); onOpenChange(false); },
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Nueva obligación</DialogTitle>
          <DialogDescription>Registra lo que un cliente le debe a otro (OC, factura, CFDI). No mueve saldo: se liquida por el neto en la siguiente corrida de compensación.</DialogDescription>
        </DialogHeader>
        <form className="grid gap-4" onSubmit={(e: FormEvent) => { e.preventDefault(); m.mutate(); }}>
          <div className="grid gap-4 sm:grid-cols-2">
            <ClientPicker label="Deudor (paga)" value={debtor} onChange={setDebtor} exclude={creditor?.id} autoFocus />
            <ClientPicker label="Acreedor (cobra)" value={creditor} onChange={setCreditor} exclude={debtor?.id} />
          </div>
          {debtor?.status === 'suspended' && <p className="text-xs text-[oklch(0.5_0.12_70)] dark:text-warning">El deudor está suspendido: la obligación se registra, pero no podrá liquidarse como pagador neto mientras siga así.</p>}
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Activo" htmlFor="no-asset">
              <Select id="no-asset" value={assetId} onChange={(e) => setAssetId(e.target.value)}>
                {assets.map((a) => <option key={a.id} value={a.id}>{a.symbol} · {a.id}</option>)}
              </Select>
            </Field>
            <Field label={`Monto${assetId ? ` (${asset.symbol})` : ''}`} htmlFor="no-amount" hint={base ? `${base} unidades base` : `Hasta ${asset.decimals} decimales, punto decimal`}>
              <Input id="no-amount" inputMode="decimal" autoComplete="off" className="font-mono" value={amountText} onChange={(e) => setAmountText(e.target.value)} aria-invalid={amountText !== '' && base == null} />
            </Field>
            <Field label="Referencia externa" htmlFor="no-ref" hint="OC, factura o UUID de CFDI (opcional)">
              <Input id="no-ref" maxLength={200} value={ref} onChange={(e) => setRef(e.target.value)} />
            </Field>
            <Field label="Vencimiento" htmlFor="no-due" hint="Sin vencimiento: entra en cualquier corte">
              <Input id="no-due" type="datetime-local" value={due} onChange={(e) => setDue(e.target.value)} />
            </Field>
          </div>
          <ErrorBox error={m.error} />
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>Cancelar</Button>
            <Button type="submit" disabled={!ready || m.isPending}>{m.isPending ? <Loader2 className="animate-spin" /> : <Plus />}Registrar</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
