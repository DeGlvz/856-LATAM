// Portal fase 3 — salidas. El cliente origina con una simulación exacta; si supera su umbral, otro usuario la aprueba
// con 2FA; después la tesorería de 856 la valida y autoriza (atada al hash de lo simulado) y se envía a la cadena.
import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, ArrowRight, Check, CheckCircle2, Circle, ExternalLink, Loader2, Plus, Settings2, X } from 'lucide-react';
import {
  EXIT_STATE, explorerFor, nativeOf, netLabel, papi, roleAtLeast,
  type BalanceRow, type ExitRow, type ExitState, type Simulation, type ThresholdRow, type WlEntry,
} from '../api';
import { usePortal } from '../auth';
import { Money } from '../money';
import { Countdown } from './Whitelist';
import { CodeInput, CopyButton, ErrorBox, Field, fmtDate } from '@/components/common';
import { exactUnits, formatUnits, parseUnits, shortHex } from '@/lib/amount';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { cn } from '@/lib/utils';

type Filter = '' | 'client_approval' | 'validation' | 'authorized' | 'sent' | 'executed' | 'closed';
const FILTERS: [Filter, string][] = [['', 'Todas'], ['client_approval', 'Por aprobar'], ['validation', 'En validación 856'],
  ['authorized', 'Autorizadas'], ['sent', 'Enviadas'], ['executed', 'Ejecutadas'], ['closed', 'Canceladas o rechazadas']];
const OPEN: ExitState[] = ['client_approval', 'validation'];

export function ExitBadge({ s }: { s: ExitState }) { const x = EXIT_STATE[s]; return <Badge variant={x.v}>{x.t}</Badge>; }

export function Exits() {
  const { me, role, isAdmin } = usePortal();
  const [filter, setFilter] = useState<Filter>('');
  const [wizard, setWizard] = useState(false);
  const [approving, setApproving] = useState<ExitRow | null>(null);
  const [cancelling, setCancelling] = useState<ExitRow | null>(null);
  const q = useInfiniteQuery({
    queryKey: ['p-exits', filter], initialPageParam: null as string | null, refetchInterval: 30_000,
    queryFn: ({ pageParam }) => {
      const p = new URLSearchParams({ limit: '50' });
      if (filter) p.set('state', filter);
      if (pageParam) p.set('cursor', pageParam);
      return papi<{ exits: ExitRow[]; next_cursor: string | null }>(`/exits?${p}`);
    },
    getNextPageParam: (l) => l.next_cursor,
  });
  const rows = q.data?.pages.flatMap((p) => p.exits) ?? [];
  const canOriginate = roleAtLeast(role, 'operator');
  const canApprove = roleAtLeast(role, 'approver');

  return (
    <div className="mx-auto grid max-w-6xl grid-cols-[minmax(0,1fr)] gap-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Salidas</h1>
          <p className="text-sm text-muted-foreground">Envíos a direcciones de su lista blanca. Usted los origina; la tesorería de 856 los valida y autoriza antes de enviarlos.</p>
        </div>
        {canOriginate && <Button onClick={() => setWizard(true)}><Plus />Nueva salida</Button>}
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Solicitudes</CardTitle>
          <CardDescription>Se actualiza cada 30 segundos.</CardDescription>
          <CardAction>
            <Select aria-label="Filtrar por estado" className="h-8 w-52" value={filter} onChange={(e) => setFilter(e.target.value as Filter)}>
              {FILTERS.map(([v, t]) => <option key={v} value={v}>{t}</option>)}
            </Select>
          </CardAction>
        </CardHeader>
        <CardContent className="grid gap-3">
          <ErrorBox error={q.error} />
          {q.isPending && <Skeleton className="h-24" />}
          {q.data && !rows.length && <p className="py-4 text-center text-sm text-muted-foreground">Sin salidas{filter ? ' con este estado' : ''}.</p>}
          {!!rows.length && (
            <div className="overflow-x-auto">
              <Table aria-label="Salidas">
                <TableHeader><TableRow><TableHead>Fecha</TableHead><TableHead>Estado</TableHead><TableHead className="text-right">Monto</TableHead><TableHead>Destino</TableHead><TableHead>Originó</TableHead><TableHead /></TableRow></TableHeader>
                <TableBody>
                  {rows.map((x) => {
                    const mine = !!me && x.origin.user_id === me.user.id;
                    return (
                      <TableRow key={x.id} data-exit={x.id}>
                        <TableCell className="text-xs whitespace-nowrap text-muted-foreground"><Link to={`/salidas/${x.id}`} className="hover:underline">{fmtDate(x.created_at)}</Link></TableCell>
                        <TableCell><ExitBadge s={x.state} /></TableCell>
                        <TableCell className="text-right"><Money v={x.amount} decimals={x.decimals} symbol={x.symbol} /></TableCell>
                        <TableCell className="font-mono text-xs" title={x.to_address}>{shortHex(x.to_address, 6)}</TableCell>
                        <TableCell className="text-xs">{x.origin.user ?? (x.origin.key ? `Llave ${x.origin.key}` : '—')}</TableCell>
                        <TableCell className="text-right whitespace-nowrap">
                          {x.state === 'client_approval' && canApprove && !mine && <Button size="sm" variant="outline" onClick={() => setApproving(x)}><Check />Aprobar</Button>}
                          {OPEN.includes(x.state) && canOriginate && <Button size="sm" variant="ghost" className="text-destructive" onClick={() => setCancelling(x)}><X />Cancelar</Button>}
                          <Button size="sm" variant="ghost" asChild><Link to={`/salidas/${x.id}`}>Ver</Link></Button>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          )}
          {q.hasNextPage && <div className="text-center"><Button variant="outline" size="sm" onClick={() => q.fetchNextPage()} disabled={q.isFetchingNextPage}>Cargar más</Button></div>}
        </CardContent>
      </Card>

      <Thresholds editable={isAdmin} />
      {canOriginate && <ExitWizard open={wizard} onClose={() => setWizard(false)} />}
      <ApproveExit exit={approving} onClose={() => setApproving(null)} />
      <CancelExit exit={cancelling} onClose={() => setCancelling(null)} />
    </div>
  );
}

// ───────────── Asistente: activo → destino → monto → confirmación con simulación ─────────────
const STEPS = ['Activo', 'Destino', 'Monto', 'Confirmación'];

function ExitWizard({ open, onClose }: { open: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const nav = useNavigate();
  const [step, setStep] = useState(0);
  const [asset, setAsset] = useState('');
  const [wl, setWl] = useState('');
  const [text, setText] = useState('');
  const [sim, setSim] = useState<Simulation | null>(null);
  const bal = useQuery({ queryKey: ['p-balances'], enabled: open, queryFn: () => papi<{ as_of: string; balances: BalanceRow[] }>('/balances') });
  const list = useQuery({ queryKey: ['p-whitelist'], enabled: open, queryFn: () => papi<{ cooldown_hours: number; entries: WlEntry[] }>('/whitelist') });
  useEffect(() => { if (open) { setStep(0); setAsset(''); setWl(''); setText(''); setSim(null); simulate.reset(); submit.reset(); } }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  const a = bal.data?.balances.find((b) => b.asset_id === asset);
  const dest = list.data?.entries.find((w) => w.id === wl);
  // Multi-red: solo destinos de la misma red que el activo
  const sameNet = (w: WlEntry) => !a || w.network === a.network;
  const usable = (list.data?.entries ?? []).filter((w) => w.state === 'active' && sameNet(w));
  const otherNet = (list.data?.entries ?? []).filter((w) => w.state === 'active' && !sameNet(w)).length;
  const cooling = (list.data?.entries ?? []).filter((w) => (w.state === 'cooling' || w.state === 'pending_approval') && sameNet(w));
  const base = a ? parseUnits(text, a.decimals) : null;
  const over = !!a && !!base && BigInt(base) > BigInt(a.available);

  const simulate = useMutation({
    mutationFn: () => papi<Simulation>('/exits/simulate', { method: 'POST', json: { asset_id: asset, whitelist_id: wl, amount: base } }),
    onSuccess: (s) => { setSim(s); setStep(3); },
  });
  const submit = useMutation({
    mutationFn: () => papi<ExitRow>('/exits', { method: 'POST', json: { simulation_id: sim!.id } }),
    onSuccess: (x) => { qc.invalidateQueries({ queryKey: ['p-exits'] }); qc.invalidateQueries({ queryKey: ['p-balances'] }); onClose(); nav(`/salidas/${x.id}`); },
  });
  const expired = !!sim && new Date(sim.expires_at) <= new Date();

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Nueva salida</DialogTitle>
          <DialogDescription>Lo que confirme es exactamente lo que 856 autorizará. Si algo cambia, tendrá que simular de nuevo.</DialogDescription>
        </DialogHeader>
        <ol className="flex flex-wrap gap-2 text-xs" aria-label="Pasos">
          {STEPS.map((t, i) => (
            <li key={t} aria-current={i === step ? 'step' : undefined} className={cn('flex items-center gap-1 rounded-full border px-2 py-0.5', i === step ? 'border-primary font-medium text-primary' : i < step ? 'text-foreground' : 'text-muted-foreground')}>
              {i < step ? <CheckCircle2 className="size-3" /> : <Circle className="size-3" />}{i + 1}. {t}
            </li>
          ))}
        </ol>

        {step === 0 && (
          <div className="grid gap-2" role="radiogroup" aria-label="Activo">
            <ErrorBox error={bal.error} />
            {bal.isPending && <Skeleton className="h-16" />}
            {bal.data?.balances.map((b) => {
              const none = BigInt(b.available) <= 0n;
              return (
                <button key={b.asset_id} type="button" role="radio" aria-checked={asset === b.asset_id} disabled={none} onClick={() => { setAsset(b.asset_id); setWl(''); }}
                  className={cn('flex items-center justify-between rounded-md border p-3 text-left text-sm disabled:opacity-50', asset === b.asset_id ? 'border-primary bg-primary/5 ring-1 ring-primary' : 'hover:bg-accent')}>
                  <span className="font-medium">{b.symbol} <span className="text-xs font-normal text-muted-foreground">{netLabel(b.network)}</span>
                    {b.asset_status === 'exit_only' && <Badge variant="secondary" className="ml-2">Solo salida</Badge>}</span>
                  <span className="text-xs">Disponible <Money v={b.available} decimals={b.decimals} symbol={b.symbol} /></span>
                </button>
              );
            })}
          </div>
        )}

        {step === 1 && (
          <div className="grid gap-2" role="radiogroup" aria-label="Destino">
            <ErrorBox error={list.error} />
            {!usable.length && <p className="text-sm text-muted-foreground">No tiene direcciones vigentes{a ? ` en ${netLabel(a.network)}` : ''}. <Link to="/lista-blanca" className="underline" onClick={onClose}>Agregue una a su lista blanca</Link>.</p>}
            {usable.map((w) => (
              <button key={w.id} type="button" role="radio" aria-checked={wl === w.id} onClick={() => setWl(w.id)}
                className={cn('grid gap-0.5 rounded-md border p-3 text-left text-sm', wl === w.id ? 'border-primary bg-primary/5 ring-1 ring-primary' : 'hover:bg-accent')}>
                <span className="font-medium">{w.label ?? 'Sin etiqueta'}</span><code className="font-mono text-xs break-all">{w.address}</code>
              </button>
            ))}
            {otherNet > 0 && <p className="text-xs text-muted-foreground">{otherNet} dirección(es) de otra red no aplican para {a?.symbol}.</p>}
            {!!cooling.length && <p className="text-xs text-muted-foreground">{cooling.length} dirección(es) aún no se pueden usar (por aprobar o en espera).</p>}
          </div>
        )}

        {step === 2 && a && (
          <div className="grid gap-3">
            <Field label={`Monto en ${a.symbol}`} htmlFor="x-amount" hint={`Hasta ${a.decimals} decimales, con punto. Disponible: ${exactUnits(a.available, a.decimals)} ${a.symbol}.`}>
              <div className="flex gap-2">
                <Input id="x-amount" autoFocus inputMode="decimal" className="font-mono" placeholder="0.00" value={text}
                  onChange={(e) => setText(e.target.value.replace(',', '.'))} aria-invalid={text !== '' && (!base || over)} />
                <Button type="button" variant="outline" onClick={() => setText(exactUnits(a.available, a.decimals))}>Máximo</Button>
              </div>
            </Field>
            {text !== '' && !base && <p className="text-sm text-destructive">Monto inválido.</p>}
            {over && <p className="text-sm text-destructive">Supera su saldo disponible.</p>}
            <ErrorBox error={simulate.error} />
          </div>
        )}

        {step === 3 && sim && (
          <div className="grid gap-3 text-sm" data-simulation={sim.id}>
            <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1.5 rounded-md border p-3">
              <dt className="text-muted-foreground">Monto exacto</dt><dd className="font-semibold" data-testid="sim-amount"><Money v={sim.amount} decimals={sim.decimals} symbol={sim.symbol} exact /></dd>
              <dt className="text-muted-foreground">Destino</dt><dd><code className="font-mono text-xs break-all">{sim.to_address}</code>{dest?.label && <div className="text-xs text-muted-foreground">{dest.label}</div>}</dd>
              <dt className="text-muted-foreground">Comisión 856</dt><dd><Money v={sim.fee} decimals={sim.decimals} symbol={sim.symbol} exact /></dd>
              <dt className="text-muted-foreground">Gas de red</dt><dd className="text-xs">Lo paga 856{sim.gas_estimate ? ` (≈ ${formatUnits(sim.gas_estimate, 18)} ${nativeOf(sim.network)})` : ''}</dd>
              <dt className="text-muted-foreground">Disponible ahora</dt><dd><Money v={sim.available} decimals={sim.decimals} symbol={sim.symbol} exact /></dd>
              <dt className="text-muted-foreground">Quedará</dt><dd><Money v={sim.balance_after} decimals={sim.decimals} symbol={sim.symbol} exact /></dd>
              <dt className="text-muted-foreground">Red</dt><dd className="text-xs">{netLabel(sim.network)}</dd>
            </dl>
            {BigInt(sim.payable_open) > 0n && (
              <div role="status" className="rounded-md border border-warning/60 bg-warning/10 p-3 text-xs">
                Tiene obligaciones abiertas por pagar en {sim.symbol} por <Money v={sim.payable_open} decimals={sim.decimals} symbol={sim.symbol} />. Si cambian antes de la autorización, 856 pedirá simular de nuevo.
              </div>
            )}
            <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
              <span>Huella de lo autorizado:</span><code className="font-mono">{shortHex(sim.scope_hash, 10)}</code><CopyButton value={sim.scope_hash} />
              <span className="ml-auto">{expired ? <span className="text-destructive">Simulación vencida: vuelva a simular.</span> : <Countdown until={sim.expires_at} prefix="La simulación vence en" />}</span>
            </div>
            <ErrorBox error={submit.error} />
          </div>
        )}

        <DialogFooter className="gap-2">
          {step > 0 && <Button type="button" variant="outline" onClick={() => { setStep(step === 3 ? 2 : step - 1); setSim(null); submit.reset(); }}><ArrowLeft />Atrás</Button>}
          {step === 0 && <Button disabled={!asset} onClick={() => setStep(1)}>Continuar<ArrowRight /></Button>}
          {step === 1 && <Button disabled={!wl} onClick={() => setStep(2)}>Continuar<ArrowRight /></Button>}
          {step === 2 && <Button disabled={!base || over || simulate.isPending} onClick={() => simulate.mutate()}>{simulate.isPending && <Loader2 className="animate-spin" />}Simular</Button>}
          {step === 3 && (expired
            ? <Button onClick={() => simulate.mutate()} disabled={simulate.isPending}>Simular de nuevo</Button>
            : <Button onClick={() => submit.mutate()} disabled={submit.isPending}>{submit.isPending && <Loader2 className="animate-spin" />}Confirmar salida</Button>)}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ───────────── Aprobación interna y cancelación ─────────────
function ApproveExit({ exit, onClose }: { exit: ExitRow | null; onClose: () => void }) {
  const qc = useQueryClient();
  const [code, setCode] = useState('');
  useEffect(() => { setCode(''); m.reset(); }, [exit]); // eslint-disable-line react-hooks/exhaustive-deps
  const m = useMutation({
    mutationFn: () => papi<ExitRow>(`/exits/${exit!.id}/approve`, { method: 'POST', json: { code } }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['p-exits'] }); qc.invalidateQueries({ queryKey: ['p-exit'] }); onClose(); },
  });
  return (
    <Dialog open={!!exit} onOpenChange={(v) => !v && onClose()}>
      <DialogContent>
        <DialogHeader><DialogTitle>Aprobar salida</DialogTitle>
          <DialogDescription>Supera el umbral de su empresa. Al aprobarla pasa a validación de la tesorería de 856.</DialogDescription></DialogHeader>
        {exit && (
          <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1 rounded-md border p-3 text-sm">
            <dt className="text-muted-foreground">Monto</dt><dd className="font-semibold"><Money v={exit.amount} decimals={exit.decimals} symbol={exit.symbol} exact /></dd>
            <dt className="text-muted-foreground">Destino</dt><dd><code className="font-mono text-xs break-all">{exit.to_address}</code></dd>
            <dt className="text-muted-foreground">Originó</dt><dd>{exit.origin.user ?? `Llave ${exit.origin.key}`}</dd>
          </dl>
        )}
        <Field label="Código 2FA"><CodeInput label="Código 2FA para aprobar la salida" autoFocus value={code} onChange={setCode} /></Field>
        <ErrorBox error={m.error} />
        <DialogFooter><Button variant="outline" onClick={onClose}>Cancelar</Button>
          <Button disabled={code.length !== 6 || m.isPending} onClick={() => m.mutate()}>{m.isPending && <Loader2 className="animate-spin" />}Aprobar</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function CancelExit({ exit, onClose }: { exit: ExitRow | null; onClose: () => void }) {
  const qc = useQueryClient();
  const m = useMutation({
    mutationFn: () => papi<ExitRow>(`/exits/${exit!.id}/cancel`, { method: 'POST', json: {} }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['p-exits'] }); qc.invalidateQueries({ queryKey: ['p-exit'] }); qc.invalidateQueries({ queryKey: ['p-balances'] }); onClose(); },
  });
  useEffect(() => { m.reset(); }, [exit]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <Dialog open={!!exit} onOpenChange={(v) => !v && onClose()}>
      <DialogContent>
        <DialogHeader><DialogTitle>Cancelar salida</DialogTitle>
          <DialogDescription>Se libera el saldo reservado. Solo puede cancelarse mientras no la haya autorizado 856.</DialogDescription></DialogHeader>
        <ErrorBox error={m.error} />
        <DialogFooter><Button variant="outline" onClick={onClose}>Volver</Button>
          <Button variant="destructive" disabled={m.isPending} onClick={() => m.mutate()}>Cancelar salida</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ───────────── Umbral de aprobación interna (administrador) ─────────────
function Thresholds({ editable }: { editable: boolean }) {
  const qc = useQueryClient();
  const t = useQuery({ queryKey: ['p-thresholds'], queryFn: () => papi<{ thresholds: ThresholdRow[] }>('/settings/approval-thresholds') });
  const bal = useQuery({ queryKey: ['p-balances'], queryFn: () => papi<{ as_of: string; balances: BalanceRow[] }>('/balances') });
  const [edit, setEdit] = useState<BalanceRow | null>(null);
  const [text, setText] = useState('');
  const [code, setCode] = useState('');
  const current = (id: string) => t.data?.thresholds.find((x) => x.asset_id === id) ?? null;
  const base = edit ? (text.trim() === '' ? null : parseUnits(text, edit.decimals)) : null;
  const m = useMutation({
    mutationFn: () => papi('/settings/approval-thresholds', { method: 'PUT', json: { asset_id: edit!.asset_id, threshold: base, code } }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['p-thresholds'] }); setEdit(null); },
  });
  const assets = useMemo(() => bal.data?.balances ?? [], [bal.data]);
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base flex items-center gap-2"><Settings2 className="size-4" />Aprobación interna</CardTitle>
        <CardDescription>A partir de este monto, una salida necesita que la apruebe otro usuario de su empresa (Aprobador o Administrador) antes de ir a 856.</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-2">
        <ErrorBox error={t.error ?? bal.error} />
        {assets.map((b) => {
          const c = current(b.asset_id);
          return (
            <div key={b.asset_id} data-threshold={b.asset_id} className="flex flex-wrap items-center justify-between gap-2 rounded-md border px-3 py-2 text-sm">
              <span className="font-medium">{b.symbol}</span>
              <span className="text-xs">{c ? <>Desde <Money v={c.threshold} decimals={b.decimals} symbol={b.symbol} /></> : <span className="text-muted-foreground">Sin umbral: toda salida va directo a 856</span>}</span>
              {editable && <Button size="sm" variant="outline" onClick={() => { setEdit(b); setText(c ? exactUnits(c.threshold, b.decimals) : ''); setCode(''); m.reset(); }}>Cambiar</Button>}
            </div>
          );
        })}
      </CardContent>
      <Dialog open={!!edit} onOpenChange={(v) => !v && setEdit(null)}>
        <DialogContent>
          <DialogHeader><DialogTitle>Umbral de aprobación {edit?.symbol}</DialogTitle>
            <DialogDescription>Déjelo vacío para quitarlo. El cambio queda en la bitácora.</DialogDescription></DialogHeader>
          <Field label={`Monto en ${edit?.symbol ?? ''}`} htmlFor="th-amount"><Input id="th-amount" inputMode="decimal" className="font-mono" value={text} onChange={(e) => setText(e.target.value.replace(',', '.'))} aria-invalid={text.trim() !== '' && !base} /></Field>
          <Field label="Código 2FA"><CodeInput label="Código 2FA para el umbral" value={code} onChange={setCode} /></Field>
          <ErrorBox error={m.error} />
          <DialogFooter><Button variant="outline" onClick={() => setEdit(null)}>Cancelar</Button>
            <Button disabled={code.length !== 6 || (text.trim() !== '' && !base) || m.isPending} onClick={() => m.mutate()}>Guardar</Button></DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}

// ───────────── Seguimiento de una salida ─────────────
export function ExitDetail() {
  const { id = '' } = useParams();
  const { me, role } = usePortal();
  const [approving, setApproving] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const q = useQuery({ queryKey: ['p-exit', id], queryFn: () => papi<ExitRow>(`/exits/${id}`), refetchInterval: 15_000 });
  const x = q.data;
  const mine = !!me && !!x && x.origin.user_id === me.user.id;
  const steps = x ? timeline(x) : [];
  return (
    <div className="mx-auto grid max-w-3xl grid-cols-[minmax(0,1fr)] gap-6">
      <div><Link to="/salidas" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:underline"><ArrowLeft className="size-4" />Salidas</Link></div>
      <ErrorBox error={q.error} />
      {q.isPending && <Skeleton className="h-48" />}
      {x && (
        <>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h1 className="text-xl font-semibold tracking-tight"><Money v={x.amount} decimals={x.decimals} symbol={x.symbol} exact /></h1>
              <p className="font-mono text-xs text-muted-foreground">Folio {x.id}</p>
            </div>
            <ExitBadge s={x.state} />
          </div>
          <Card><CardContent className="grid gap-2 text-sm">
            <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1.5">
              <dt className="text-muted-foreground">Destino</dt><dd className="flex items-center gap-1"><code className="font-mono text-xs break-all">{x.to_address}</code><CopyButton value={x.to_address} /></dd>
              <dt className="text-muted-foreground">Originó</dt><dd>{x.origin.user ?? (x.origin.key ? `Llave ${x.origin.key}` : '—')}</dd>
              <dt className="text-muted-foreground">Huella</dt><dd className="flex items-center gap-1"><code className="font-mono text-xs">{shortHex(x.scope_hash, 10)}</code><CopyButton value={x.scope_hash} /></dd>
              {x.tx_hash && <><dt className="text-muted-foreground">Transacción</dt><dd>
                <a className="inline-flex items-center gap-1 font-mono text-xs hover:underline" href={`${explorerFor(x.network)}/tx/${x.tx_hash}`} target="_blank" rel="noreferrer noopener" data-testid="exit-tx">{shortHex(x.tx_hash, 10)}<ExternalLink className="size-3" /></a></dd></>}
              {x.rejection_reason && <><dt className="text-muted-foreground">Motivo</dt><dd className="text-destructive">{x.rejection_reason}</dd></>}
            </dl>
          </CardContent></Card>
          <Card><CardContent>
            <ol className="grid gap-3" aria-label="Seguimiento">
              {steps.map((s) => (
                <li key={s.t} className="flex items-start gap-3 text-sm">
                  {s.done ? <CheckCircle2 className="mt-0.5 size-4 text-success" /> : s.bad ? <X className="mt-0.5 size-4 text-destructive" /> : <Circle className={cn('mt-0.5 size-4', s.current ? 'text-primary' : 'text-muted-foreground')} />}
                  <div><div className={cn(s.current && 'font-medium')}>{s.t}</div>{s.d && <div className="text-xs text-muted-foreground">{s.d}</div>}</div>
                </li>
              ))}
            </ol>
          </CardContent></Card>
          <div className="flex flex-wrap gap-2">
            {x.state === 'client_approval' && roleAtLeast(role, 'approver') && !mine && <Button onClick={() => setApproving(true)}><Check />Aprobar</Button>}
            {OPEN.includes(x.state) && roleAtLeast(role, 'operator') && <Button variant="outline" className="text-destructive" onClick={() => setCancelling(true)}><X />Cancelar salida</Button>}
          </div>
          <ApproveExit exit={approving ? x : null} onClose={() => setApproving(false)} />
          <CancelExit exit={cancelling ? x : null} onClose={() => setCancelling(false)} />
        </>
      )}
    </div>
  );
}

function timeline(x: ExitRow) {
  const order: ExitState[] = ['client_approval', 'validation', 'authorized', 'sent', 'executed'];
  const at = order.indexOf(x.state);
  const closed = at < 0;
  const reached = (s: ExitState) => !closed && at > order.indexOf(s);
  const cur = (s: ExitState) => x.state === s;
  const out: { t: string; d?: string; done?: boolean; current?: boolean; bad?: boolean }[] = [
    { t: 'Solicitada', d: fmtDate(x.created_at), done: true },
  ];
  if (x.client_approved_at || x.state === 'client_approval') out.push({ t: 'Aprobación interna', d: x.client_approved_at ? `${x.client_approver ?? ''} · ${fmtDate(x.client_approved_at)}` : 'Espera a otro usuario de su empresa', done: !!x.client_approved_at, current: cur('client_approval') });
  out.push({ t: 'Validación de 856', d: x.state === 'validation' && x.validation_due_at ? `Respuesta estimada antes de ${fmtDate(x.validation_due_at)}` : undefined, done: reached('validation'), current: cur('validation') });
  out.push({ t: `Autorización de tesorería${x.authorizations.required > 1 ? ` (${x.authorizations.given}/${x.authorizations.required})` : ''}`, d: x.authorized_at ? fmtDate(x.authorized_at) : undefined, done: reached('authorized') || (!!x.authorized_at && !closed), current: cur('authorized') });
  out.push({ t: 'Enviada a la red', d: x.tx_hash ? shortHex(x.tx_hash, 10) : undefined, done: reached('sent'), current: cur('sent') });
  out.push({ t: 'Ejecutada', d: x.state === 'executed' ? `${x.confirmations ?? x.required_confirmations} confirmaciones` : x.state === 'sent' ? `${x.confirmations ?? 0}/${x.required_confirmations} confirmaciones` : undefined, done: x.state === 'executed' });
  if (closed) out.push({ t: EXIT_STATE[x.state].t, d: x.rejection_reason ?? fmtDate(x.updated_at), bad: true });
  return out;
}
