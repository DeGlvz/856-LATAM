import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, ArrowLeft, CheckCircle2, Info, Loader2, Play, Plus, Scale, X } from 'lucide-react';
import { api, newIdemKey, type NettingPreview, type NettingRunDetail, type NettingRunRow, type ObligationRow, type ObligationStatus, type RunStatus, type Summary } from '@/lib/api';
import { ago, exactUnits } from '@/lib/amount';
import { useAuth } from '@/lib/auth';
import { useAssets } from '@/lib/hooks';
import { Amount, CopyButton, ErrorBox, Field, fmtDate, StatusBadge } from '@/components/common';
import { EntryDialog } from '@/components/EntryDialog';
import { ApprovalPanel } from '@/components/ApprovalPanel';
import { NewObligationDialog, OB_STATUS, ObligationDialog, ObligationsTable } from '@/components/ObligationDialogs';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Tabs } from '@/components/ui/tabs';
import { cn } from '@/lib/utils';

type Tab = 'obligaciones' | 'simular' | 'corridas';
export const RUN_STATUS: Record<RunStatus, { label: string; variant: 'warning' | 'success' | 'outline' }> = {
  pending_approval: { label: 'Por aprobar', variant: 'warning' }, settled: { label: 'Liquidada', variant: 'success' }, rejected: { label: 'Rechazada', variant: 'outline' },
};
const pct = (bps: number) => `${(bps / 100).toLocaleString('es-MX', { maximumFractionDigits: 2 })} %`;

export function Netting() {
  const { can } = useAuth();
  const { assets } = useAssets();
  const [sp, setSp] = useSearchParams();
  const tab = (sp.get('tab') as Tab) || 'obligaciones';
  const set = (k: string, v: string | null) => { const n = new URLSearchParams(sp); if (v) n.set(k, v); else n.delete(k); setSp(n, { replace: true }); };
  const assetId = sp.get('asset') ?? '';
  useEffect(() => { if (!assetId && assets[0]) set('asset', assets.find((a) => a.id === 'USDC-ETH-SEPOLIA')?.id ?? assets[0].id); }, [assets, assetId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Selección de obligaciones abiertas para simular solo ese subconjunto (por activo)
  const [selected, setSelected] = useState<Map<string, ObligationRow>>(new Map());
  useEffect(() => setSelected(new Map()), [assetId]);
  const toggle = (o: ObligationRow) => setSelected((s) => { const n = new Map(s); if (n.has(o.id)) n.delete(o.id); else n.set(o.id, o); return n; });

  const [newOb, setNewOb] = useState(false);
  const [openOb, setOpenOb] = useState<ObligationRow | null>(null);
  const [runId, setRunId] = useState<string | null>(null);

  return (
    <div className="mx-auto grid max-w-7xl grid-cols-[minmax(0,1fr)] gap-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Compensación</h1>
          <p className="text-sm text-muted-foreground">Obligaciones entre clientes y liquidación multilateral por el neto, en un solo asiento.</p>
        </div>
        <div className="flex flex-wrap gap-2">
          {can('ejecutivo') && <Button variant="outline" onClick={() => setNewOb(true)}><Plus />Nueva obligación</Button>}
          <Button onClick={() => set('tab', 'simular')}><Scale />Simular corrida</Button>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <Tabs<Tab> value={tab} onChange={(v) => set('tab', v)} items={[
          { value: 'obligaciones', label: 'Obligaciones' },
          { value: 'simular', label: 'Simular y liquidar', count: selected.size || undefined },
          { value: 'corridas', label: 'Corridas' },
        ]} />
        <Select aria-label="Activo" className="h-9 w-full sm:w-72" value={assetId} onChange={(e) => set('asset', e.target.value)}>
          {assets.map((a) => <option key={a.id} value={a.id}>{a.symbol} · {a.id}</option>)}
        </Select>
      </div>

      {tab === 'obligaciones' && assetId && (
        <ObligationsTab assetId={assetId} sp={sp} set={set} selected={selected} toggle={toggle} onOpen={setOpenOb}
          onSimulate={() => set('tab', 'simular')} onClear={() => setSelected(new Map())} />
      )}
      {tab === 'simular' && assetId && (
        <SimulateTab assetId={assetId} selected={selected} onClear={() => setSelected(new Map())}
          onSettled={(id) => { setSelected(new Map()); set('tab', 'corridas'); setRunId(id); }} />
      )}
      {tab === 'corridas' && assetId && <RunsTab assetId={assetId} onOpen={setRunId} />}

      <NewObligationDialog open={newOb} onOpenChange={setNewOb} presetAssetId={assetId || undefined} />
      <ObligationDialog obligation={openOb} onClose={() => setOpenOb(null)} onOpenRun={(id) => { setOpenOb(null); setRunId(id); }} />
      <RunDialog id={runId} onClose={() => setRunId(null)} />
    </div>
  );
}

// ───────────── Obligaciones ─────────────
function ObligationsTab({ assetId, sp, set, selected, toggle, onOpen, onSimulate, onClear }: {
  assetId: string; sp: URLSearchParams; set: (k: string, v: string | null) => void;
  selected: Map<string, ObligationRow>; toggle: (o: ObligationRow) => void; onOpen: (o: ObligationRow) => void;
  onSimulate: () => void; onClear: () => void;
}) {
  const status = (sp.get('status') ?? 'open') as ObligationStatus | 'all';
  const [refText, setRefText] = useState(sp.get('ref') ?? '');
  useEffect(() => { const t = setTimeout(() => set('ref', refText.trim() || null), 300); return () => clearTimeout(t); }, [refText]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <Card className="py-2"><CardContent className="grid gap-3 px-3">
      <div className="flex flex-wrap items-center gap-3 pt-2">
        <Select aria-label="Estado" className="h-9 w-44" value={status} onChange={(e) => set('status', e.target.value === 'open' ? null : e.target.value)}>
          {Object.entries(OB_STATUS).map(([k, v]) => <option key={k} value={k}>{v.label}s</option>)}
          <option value="all">Todas</option>
        </Select>
        <Input aria-label="Buscar referencia" className="h-9 w-64" placeholder="Referencia (OC, factura, CFDI)" value={refText} onChange={(e) => setRefText(e.target.value)} />
        {selected.size > 0 && (
          <div className="ml-auto flex items-center gap-2 text-sm">
            <span>{selected.size} seleccionada(s)</span>
            <Button size="sm" variant="ghost" onClick={onClear}><X />Limpiar</Button>
            <Button size="sm" onClick={onSimulate}><Scale />Simular selección</Button>
          </div>
        )}
      </div>
      <ObligationsTable params={{ asset_id: assetId, status: status === 'all' ? undefined : status, external_ref: sp.get('ref') ?? undefined }}
        selectable selected={new Set(selected.keys())} onToggle={toggle} onOpen={onOpen} />
    </CardContent></Card>
  );
}

// ───────────── Simulación y liquidación ─────────────
function SimulateTab({ assetId, selected, onClear, onSettled }: {
  assetId: string; selected: Map<string, ObligationRow>; onClear: () => void; onSettled: (runId: string) => void;
}) {
  const { can } = useAuth();
  const { byId } = useAssets();
  const qc = useQueryClient();
  const a = byId(assetId);
  const [mode, setMode] = useState<'cutoff' | 'selection'>(selected.size ? 'selection' : 'cutoff');
  useEffect(() => { if (!selected.size && mode === 'selection') setMode('cutoff'); }, [selected.size, mode]);
  const [cutoff, setCutoff] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [key, setKey] = useState(newIdemKey);
  const dual = (useQuery({ queryKey: ['summary'], queryFn: () => api<Summary>('/summary'), staleTime: 60_000 }).data?.dual_approval ?? 'console') !== 'off';

  const scope: { asset_id: string; cutoff?: string; obligation_ids?: string[] } = {
    asset_id: assetId,
    ...(mode === 'selection' ? { obligation_ids: [...selected.keys()] } : cutoff ? { cutoff: new Date(cutoff).toISOString() } : {}),
  };
  const preview = useMutation({ mutationFn: () => api<NettingPreview>('/netting/preview', { method: 'POST', json: scope }) });
  const p = preview.data;
  // Cualquier cambio de alcance invalida la simulación vista
  useEffect(() => { preview.reset(); setConfirming(false); }, [assetId, mode, cutoff, selected.size]); // eslint-disable-line react-hooks/exhaustive-deps

  const run = useMutation({
    // Se liquidan exactamente las obligaciones simuladas, y el servidor verifica que el neto no cambió
    mutationFn: () => api<NettingRunDetail>('/netting/runs', {
      method: 'POST', headers: { 'idempotency-key': key },
      json: { asset_id: assetId, obligation_ids: p!.obligation_ids, expected_net_amount: p!.net_amount, ...(scope.cutoff ? { cutoff: scope.cutoff } : {}) },
    }),
    onSuccess: (r) => {
      ['obligations', 'netting-runs', 'client', 'entries', 'summary'].forEach((k) => qc.invalidateQueries({ queryKey: [k] }));
      setKey(newIdemKey()); setConfirming(false); preview.reset(); onSettled(r.id);
    },
    onError: () => setKey(newIdemKey()),
  });

  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-4">
      <Card>
        <CardHeader>
          <CardTitle>Alcance</CardTitle>
          <CardDescription>La simulación no mueve nada. La liquidación toma exactamente las obligaciones simuladas.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4">
          <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="Alcance">
            <Button type="button" variant={mode === 'cutoff' ? 'default' : 'outline'} size="sm" role="radio" aria-checked={mode === 'cutoff'} onClick={() => setMode('cutoff')}>Todas las abiertas al corte</Button>
            <Button type="button" variant={mode === 'selection' ? 'default' : 'outline'} size="sm" role="radio" aria-checked={mode === 'selection'} disabled={!selected.size} onClick={() => setMode('selection')}>
              Selección ({selected.size})
            </Button>
          </div>
          {mode === 'cutoff' ? (
            <div className="grid gap-2 sm:max-w-sm">
              <Field label="Corte (vencimiento hasta)" htmlFor="nt-cutoff" hint="Vacío: todas las abiertas del activo.">
                <Input id="nt-cutoff" type="datetime-local" value={cutoff} onChange={(e) => setCutoff(e.target.value)} />
              </Field>
              <p className="flex items-start gap-1.5 text-xs text-muted-foreground"><Info className="mt-0.5 size-3.5 shrink-0" />Las obligaciones sin vencimiento entran siempre, con o sin corte.</p>
            </div>
          ) : (
            <div className="flex flex-wrap items-center gap-2 text-sm">
              {[...selected.values()].slice(0, 6).map((o) => <Badge key={o.id} variant="secondary" className="font-mono">{o.external_ref ?? o.id.slice(0, 8)}</Badge>)}
              {selected.size > 6 && <span className="text-muted-foreground">+{selected.size - 6}</span>}
              <Button size="sm" variant="ghost" onClick={onClear}><X />Limpiar</Button>
            </div>
          )}
          <div><Button onClick={() => preview.mutate()} disabled={preview.isPending}>{preview.isPending ? <Loader2 className="animate-spin" /> : <Scale />}Simular</Button></div>
          <ErrorBox error={preview.error} />
        </CardContent>
      </Card>

      {p && (
        <>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <Stat label="Obligaciones" value={String(p.obligations)} sub={`${p.participants} participantes`} />
            <Stat label="Bruto" value={<Amount v={p.gross_amount} asset={a} />} />
            <Stat label="Neto a mover" value={<Amount v={p.net_amount} asset={a} />} />
            <Stat label="Ahorro" value={pct(p.savings_bps)} sub="del bruto no se mueve" accent />
          </div>

          {p.obligations === 0 ? (
            <Card><CardContent className="py-8 text-center text-sm text-muted-foreground">No hay obligaciones abiertas en el alcance.</CardContent></Card>
          ) : (
            <Card className="py-2"><CardContent className="px-3">
              <Table>
                <TableHeader><TableRow>
                  <TableHead>Cliente</TableHead><TableHead className="text-right">Por cobrar</TableHead><TableHead className="text-right">Por pagar</TableHead>
                  <TableHead className="text-right">Neto</TableHead><TableHead className="text-right">Disponible</TableHead><TableHead>Situación</TableHead>
                </TableRow></TableHeader>
                <TableBody>
                  {p.positions.map((x) => {
                    const short = x.shortfall !== '0';
                    return (
                      <TableRow key={x.client_id} className={cn((short || x.blocked) && 'bg-destructive/5')}>
                        <TableCell><Link to={`/clientes/${x.client_id}`} className="font-medium hover:underline">{x.client_name}</Link></TableCell>
                        <TableCell className="text-right"><Amount v={x.receivable} asset={a} symbol={false} /></TableCell>
                        <TableCell className="text-right"><Amount v={x.payable} asset={a} symbol={false} /></TableCell>
                        <TableCell className="text-right"><Amount v={x.net} asset={a} symbol={false} className={x.net.startsWith('-') ? 'text-destructive' : x.net === '0' ? 'text-muted-foreground' : 'text-success'} /></TableCell>
                        <TableCell className="text-right"><Amount v={x.available} asset={a} symbol={false} /></TableCell>
                        <TableCell className="flex flex-wrap items-center gap-1.5">
                          {x.blocked && <StatusBadge status={x.client_status} />}
                          {short && <Badge variant="destructive">Faltan <Amount v={x.shortfall} asset={a} symbol={false} className="text-[11px]" /></Badge>}
                          {!x.blocked && !short && <Badge variant="outline">{x.net.startsWith('-') ? 'Paga' : x.net === '0' ? 'Cruza en cero' : 'Recibe'}</Badge>}
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </CardContent></Card>
          )}

          {p.obligations > 0 && !p.can_settle && (
            <ErrorBox error={p.blocked_clients.length
              ? 'No liquidable: hay pagadores netos suspendidos o cerrados. Excluya sus obligaciones (simule una selección) o reactívelos.'
              : 'No liquidable: al menos un pagador neto no tiene saldo suficiente. Fondee su cuenta o excluya sus obligaciones.'} />
          )}

          {p.can_settle && (can('tesorero') ? (
            confirming ? (
              <div className="grid gap-3 rounded-md border border-warning/60 bg-warning/10 p-4 text-sm">
                <div className="flex items-center gap-2 font-medium"><AlertTriangle className="size-4" />
                  {dual ? 'Confirme la solicitud: un segundo tesorero con 2FA debe aprobarla para liquidar.' : 'Confirme la liquidación: se registra un asiento y las obligaciones quedan liquidadas.'}</div>
                <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
                  <dt className="text-muted-foreground">Obligaciones</dt><dd>{p.obligations} · {p.participants} participantes</dd>
                  <dt className="text-muted-foreground">Bruto</dt><dd className="font-mono">{exactUnits(p.gross_amount, a.decimals)} {a.symbol}</dd>
                  <dt className="text-muted-foreground">Neto a mover</dt><dd className="font-mono font-semibold">{exactUnits(p.net_amount, a.decimals)} {a.symbol}</dd>
                  <dt className="text-muted-foreground">Unidades base</dt><dd className="font-mono text-xs">{p.net_amount}</dd>
                </dl>
                <ErrorBox error={run.error} />
                <div className="flex flex-wrap justify-end gap-2">
                  <Button variant="outline" onClick={() => setConfirming(false)}><ArrowLeft />Corregir</Button>
                  <Button onClick={() => run.mutate()} disabled={run.isPending}>{run.isPending ? <Loader2 className="animate-spin" /> : <Play />}{dual ? 'Solicitar liquidación' : 'Confirmar liquidación'}</Button>
                </div>
              </div>
            ) : (
              <div className="flex justify-end"><Button onClick={() => setConfirming(true)}><CheckCircle2 />{dual ? 'Solicitar liquidación…' : 'Liquidar…'}</Button></div>
            )
          ) : (
            <p className="text-right text-sm text-muted-foreground">Liquidable. Solo un tesorero puede ejecutar la corrida.</p>
          ))}
        </>
      )}
    </div>
  );
}

function Stat({ label, value, sub, accent }: { label: string; value: React.ReactNode; sub?: string; accent?: boolean }) {
  return (
    <Card className="gap-1 py-4"><CardContent className="px-4">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className={cn('mt-1 text-lg font-semibold', accent && 'text-success')}>{value}</div>
      {sub && <div className="text-xs text-muted-foreground">{sub}</div>}
    </CardContent></Card>
  );
}

// ───────────── Historial de corridas ─────────────
function RunsTab({ assetId, onOpen }: { assetId: string; onOpen: (id: string) => void }) {
  const { byId } = useAssets();
  const q = useInfiniteQuery({
    queryKey: ['netting-runs', assetId],
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) => api<{ runs: NettingRunRow[]; next_cursor: string | null }>(`/netting/runs?limit=50&asset_id=${encodeURIComponent(assetId)}${pageParam ? `&cursor=${pageParam}` : ''}`),
    getNextPageParam: (l) => l.next_cursor,
  });
  const rows = q.data?.pages.flatMap((p) => p.runs) ?? [];
  const a = byId(assetId);
  return (
    <Card className="py-2"><CardContent className="px-3">
      <ErrorBox error={q.error} />
      <Table>
        <TableHeader><TableRow>
          <TableHead>Corrida</TableHead><TableHead>Estado</TableHead><TableHead className="text-right">Obligaciones</TableHead><TableHead className="text-right">Bruto</TableHead>
          <TableHead className="text-right">Neto</TableHead><TableHead className="text-right">Ahorro</TableHead><TableHead>Solicitó</TableHead><TableHead className="text-right">Fecha</TableHead>
        </TableRow></TableHeader>
        <TableBody>
          {q.isPending && <TableRow><TableCell colSpan={8}><Skeleton className="h-6" /></TableCell></TableRow>}
          {!q.isPending && rows.length === 0 && <TableRow><TableCell colSpan={8} className="py-8 text-center text-muted-foreground">Sin corridas</TableCell></TableRow>}
          {rows.map((r) => (
            <TableRow key={r.id} className="cursor-pointer" onClick={() => onOpen(r.id)}>
              <TableCell className="font-mono text-xs">{r.id.slice(0, 8)}</TableCell>
              <TableCell><Badge variant={RUN_STATUS[r.status].variant}>{RUN_STATUS[r.status].label}</Badge></TableCell>
              <TableCell className="num text-right">{r.obligations} <span className="text-muted-foreground">· {r.participants}</span></TableCell>
              <TableCell className="text-right"><Amount v={r.gross_amount} asset={a} /></TableCell>
              <TableCell className="text-right"><Amount v={r.net_amount} asset={a} /></TableCell>
              <TableCell className="num text-right text-success">{pct(r.savings_bps)}</TableCell>
              <TableCell className="max-w-48 truncate text-xs">{r.created_by ?? '—'}</TableCell>
              <TableCell className="num text-right text-muted-foreground" title={fmtDate(r.created_at)}>{ago(r.created_at)}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      {q.hasNextPage && (
        <div className="flex justify-center py-3">
          <Button variant="outline" size="sm" onClick={() => q.fetchNextPage()} disabled={q.isFetchingNextPage}>{q.isFetchingNextPage && <Loader2 className="animate-spin" />}Cargar más</Button>
        </div>
      )}
    </CardContent></Card>
  );
}

export function RunDialog({ id, onClose }: { id: string | null; onClose: () => void }) {
  const { byId } = useAssets();
  const [entryId, setEntryId] = useState<string | null>(null);
  const q = useQuery({ queryKey: ['netting-run', id], queryFn: () => api<NettingRunDetail>(`/netting/runs/${id}`), enabled: !!id });
  const r = q.data;
  const a = r ? byId(r.asset_id) : null;
  return (
    <>
      <Dialog open={!!id && !entryId} onOpenChange={(v) => !v && onClose()}>
        <DialogContent className="sm:max-w-3xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">Corrida de compensación {r && <Badge variant={RUN_STATUS[r.status].variant}>{RUN_STATUS[r.status].label}</Badge>}</DialogTitle>
            <DialogDescription className="flex items-center gap-1 font-mono text-xs">{id}{id && <CopyButton value={id} />}</DialogDescription>
          </DialogHeader>
          <ErrorBox error={q.error} />
          {q.isPending && id && <Skeleton className="h-48" />}
          {r && a && (
            <div className="grid max-h-[65vh] gap-4 overflow-y-auto">
              <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-sm">
                <dt className="text-muted-foreground">Activo</dt><dd>{a.symbol} · {r.asset_id}</dd>
                <dt className="text-muted-foreground">Bruto</dt><dd><Amount v={r.gross_amount} asset={a} exact /></dd>
                <dt className="text-muted-foreground">{r.status === 'settled' ? 'Neto movido' : 'Neto solicitado'}</dt><dd><Amount v={r.net_amount} asset={a} exact /> <span className="text-success">· ahorro {pct(r.savings_bps)}</span></dd>
                <dt className="text-muted-foreground">Corte</dt><dd>{r.cutoff ? fmtDate(r.cutoff) : 'Sin corte'}</dd>
                <dt className="text-muted-foreground">Solicitó</dt><dd>{r.created_by ?? '—'} · {fmtDate(r.created_at)}</dd>
                {r.approved_by && <><dt className="text-muted-foreground">Aprobó</dt><dd>{r.approved_by}{r.decided_at && <> · {fmtDate(r.decided_at)}</>}</dd></>}
                {r.rejected_by && <><dt className="text-muted-foreground">Rechazó</dt><dd>{r.rejected_by} · «{r.rejected_reason}»</dd></>}
              </dl>
              {r.status === 'pending_approval' && r.preview && (
                r.preview.can_settle
                  ? <p className="rounded-md bg-success/10 px-3 py-2 text-sm">Simulación vigente: las {r.obligations.length} obligaciones siguen abiertas y el neto no cambió. Liquidable.</p>
                  : <ErrorBox error={!r.preview.all_open ? 'Alguna obligación ya no está abierta: al aprobar se rechazará. Rechace la corrida y vuelva a simular.'
                    : !r.preview.net_matches ? 'El neto cambió desde la solicitud: rechace y vuelva a simular.'
                    : 'Hoy no es liquidable (faltante de saldo o pagador bloqueado).'} />
              )}
              {r.status === 'pending_approval' && r.last_error && <p className="text-sm text-destructive">Último intento de aprobación: {r.last_error}</p>}
              {r.status === 'pending_approval' && <ApprovalPanel kind="run" id={r.id} requestedByOperator={r.requested_by_operator} requestedBy={r.created_by} />}
              {r.status === 'settled' && (r.entry_id
                ? <div><Button size="sm" variant="outline" onClick={() => setEntryId(r.entry_id)}>Ver asiento de compensación</Button></div>
                : <p className="text-sm text-muted-foreground">Todas las posiciones netas fueron cero: no hubo asiento.</p>)}
              <div>
                <h3 className="mb-1 text-sm font-medium">{r.status === 'settled' ? 'Posiciones' : 'Posiciones (recalculadas ahora)'}</h3>
                <Table>
                  <TableHeader><TableRow><TableHead>Cliente</TableHead><TableHead className="text-right">Por cobrar</TableHead><TableHead className="text-right">Por pagar</TableHead><TableHead className="text-right">Neto</TableHead></TableRow></TableHeader>
                  <TableBody>
                    {r.positions.map((x) => (
                      <TableRow key={x.client_id}>
                        <TableCell><Link to={`/clientes/${x.client_id}`} onClick={onClose} className="hover:underline">{x.client_name}</Link></TableCell>
                        <TableCell className="text-right"><Amount v={x.receivable} asset={a} symbol={false} /></TableCell>
                        <TableCell className="text-right"><Amount v={x.payable} asset={a} symbol={false} /></TableCell>
                        <TableCell className="text-right"><Amount v={x.net} asset={a} symbol={false} className={x.net.startsWith('-') ? 'text-destructive' : ''} /></TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
              <div>
                <h3 className="mb-1 text-sm font-medium">{r.status === 'settled' ? 'Obligaciones liquidadas' : 'Obligaciones solicitadas'} ({r.obligations.length})</h3>
                <Table>
                  <TableHeader><TableRow><TableHead>Deudor → acreedor</TableHead><TableHead>Referencia</TableHead><TableHead className="text-right">Monto</TableHead></TableRow></TableHeader>
                  <TableBody>
                    {r.obligations.map((o) => (
                      <TableRow key={o.id}>
                        <TableCell className="text-sm">{o.debtor_name} <span className="text-muted-foreground">→</span> {o.creditor_name}</TableCell>
                        <TableCell className="font-mono text-xs">{o.external_ref ?? '—'}{o.status && o.status !== 'open' && r.status === 'pending_approval' && <Badge variant="destructive" className="ml-2">{OB_STATUS[o.status].label}</Badge>}</TableCell>
                        <TableCell className="text-right"><Amount v={o.amount} asset={a} symbol={false} /></TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </div>
          )}
          <DialogFooter><Button variant="outline" onClick={onClose}>Cerrar</Button></DialogFooter>
        </DialogContent>
      </Dialog>
      <EntryDialog id={entryId} onClose={() => setEntryId(null)} />
    </>
  );
}
