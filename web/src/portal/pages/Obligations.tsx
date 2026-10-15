// Portal fase 4 — obligaciones. El acreedor las registra (una por una o por CSV) con el código de contraparte de su
// deudor; el deudor las acepta o rechaza con motivo. Solo las aceptadas entran a compensación. El servidor valida todo.
import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { useSearchParams } from 'react-router';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Download, FileUp, Loader2, Plus, Search, X } from 'lucide-react';
import { OB_STATE, papi, roleAtLeast, type BalanceRow, type ObImport, type ObRow, type ObStatus, type ThresholdRow } from '../api';
import { usePortal } from '../auth';
import { Money } from '../money';
import { Countdown } from './Whitelist';
import { CodeInput, CopyButton, ErrorBox, Field, fmtDate } from '@/components/common';
import { exactUnits, parseUnits } from '@/lib/amount';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Tabs } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';

type Tab = 'aceptar' | 'cobrar' | 'pagar';
const KEYS = ['p-obligations', 'p-notices', 'p-positions', 'p-balances'];

/** Código de contraparte propio, para compartirlo con quien le facturará. */
export function CounterpartyCode({ compact }: { compact?: boolean }) {
  const q = useQuery({ queryKey: ['p-counterparty'], queryFn: () => papi<{ counterparty_code: string; name: string }>('/counterparty'), staleTime: Infinity });
  if (!q.data) return null;
  return (
    <div data-testid="my-code" className={compact ? 'flex flex-wrap items-center gap-2 text-sm' : 'flex flex-wrap items-center gap-2 rounded-md border px-3 py-2 text-sm'}>
      <span className="text-muted-foreground">Su código de contraparte</span>
      <code className="font-mono font-semibold tracking-wide">{q.data.counterparty_code}</code><CopyButton value={q.data.counterparty_code} />
      {!compact && <span className="text-xs text-muted-foreground">Compártalo con sus proveedores para que le registren obligaciones.</span>}
    </div>
  );
}

export function Obligations() {
  const { role } = usePortal();
  const [sp, setSp] = useSearchParams();
  const tab = (sp.get('tab') as Tab) ?? 'aceptar';
  const status = (sp.get('status') ?? '') as ObStatus | '';
  const set = (k: string, v: string | null) => { const n = new URLSearchParams(sp); if (v) n.set(k, v); else n.delete(k); if (k === 'tab') n.delete('status'); setSp(n, { replace: true }); };
  const canTrade = roleAtLeast(role, 'operator');
  const [creating, setCreating] = useState(false);
  const [importing, setImporting] = useState(false);
  const [deciding, setDeciding] = useState<{ o: ObRow; action: 'accept' | 'reject' | 'cancel' } | null>(null);

  const query = tab === 'aceptar' ? { role: 'debtor', status: 'pending_acceptance' } : { role: tab === 'cobrar' ? 'creditor' : 'debtor', status: status || undefined };
  const q = useInfiniteQuery({
    queryKey: ['p-obligations', query], initialPageParam: null as string | null, refetchInterval: 30_000,
    queryFn: ({ pageParam }) => {
      const p = new URLSearchParams({ limit: '50', role: query.role });
      if (query.status) p.set('status', query.status);
      if (pageParam) p.set('cursor', pageParam);
      return papi<{ obligations: ObRow[]; next_cursor: string | null; to_accept: number }>(`/obligations?${p}`);
    },
    getNextPageParam: (l) => l.next_cursor,
  });
  const rows = q.data?.pages.flatMap((p) => p.obligations) ?? [];
  // En "Por pagar" lo pendiente se ve en su propia pestaña
  const visible = tab === 'pagar' && !status ? rows.filter((o) => o.status !== 'pending_acceptance') : rows;
  const toAccept = q.data?.pages[0]?.to_accept;

  return (
    <div className="mx-auto grid max-w-6xl grid-cols-[minmax(0,1fr)] gap-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Obligaciones</h1>
          <p className="text-sm text-muted-foreground">Lo que le deben y lo que debe dentro del ecosistema 856. Solo las aceptadas por el deudor entran a compensación.</p>
        </div>
        {canTrade && (
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" onClick={() => setImporting(true)}><FileUp />Cargar CSV</Button>
            <Button onClick={() => setCreating(true)}><Plus />Registrar obligación</Button>
          </div>
        )}
      </div>
      <CounterpartyCode />
      <div className="flex flex-wrap items-center gap-3">
        <Tabs value={tab} onChange={(v) => set('tab', v)} items={[
          { value: 'aceptar', label: 'Por aceptar', count: toAccept },
          { value: 'cobrar', label: 'Por cobrar' }, { value: 'pagar', label: 'Por pagar' },
        ]} />
        {tab !== 'aceptar' && (
          <Select aria-label="Estado" className="h-9 w-48" value={status} onChange={(e) => set('status', e.target.value || null)}>
            <option value="">Todas</option>
            {(Object.keys(OB_STATE) as ObStatus[]).filter((s) => tab === 'cobrar' || s !== 'pending_acceptance').map((s) => <option key={s} value={s}>{OB_STATE[s].t}</option>)}
          </Select>
        )}
      </div>
      <ErrorBox error={q.error} />
      <Card className="py-2"><CardContent className="px-3">
        {q.isPending ? <Skeleton className="h-24" /> : (
          <div className="overflow-x-auto">
            <Table aria-label="Obligaciones">
              <TableHeader><TableRow>
                <TableHead>Registrada</TableHead><TableHead>{tab === 'cobrar' ? 'Deudor' : 'Acreedor'}</TableHead><TableHead>Referencia</TableHead>
                <TableHead className="text-right">Monto</TableHead><TableHead>Vence</TableHead><TableHead>Estado</TableHead><TableHead />
              </TableRow></TableHeader>
              <TableBody>
                {!visible.length && <TableRow><TableCell colSpan={7} className="py-8 text-center text-muted-foreground">
                  {tab === 'aceptar' ? 'No tiene obligaciones por aceptar.' : 'Sin obligaciones con este filtro.'}</TableCell></TableRow>}
                {visible.map((o) => (
                  <TableRow key={o.id} data-ob={o.external_ref ?? o.id}>
                    <TableCell className="text-xs whitespace-nowrap text-muted-foreground">{fmtDate(o.created_at)}</TableCell>
                    <TableCell className="text-sm">{o.counterparty.name}</TableCell>
                    <TableCell className="font-mono text-xs">{o.external_ref ?? '—'}</TableCell>
                    <TableCell className="text-right"><Money v={o.amount} decimals={o.decimals} symbol={o.symbol} /></TableCell>
                    <TableCell className="text-xs">{o.due_at ? fmtDate(o.due_at) : '—'}</TableCell>
                    <TableCell>
                      <div className="flex flex-wrap items-center gap-2">
                        <Badge variant={OB_STATE[o.status].v}>{OB_STATE[o.status].t}</Badge>
                        {o.status === 'pending_acceptance' && o.accept_due_at && <Countdown until={o.accept_due_at} prefix="vence en" />}
                        {o.in_pending_run && <span className="text-xs text-muted-foreground">en corrida</span>}
                      </div>
                      {o.status === 'rejected' && o.rejected_reason && <div className="text-xs text-muted-foreground">«{o.rejected_reason}»</div>}
                    </TableCell>
                    <TableCell className="text-right whitespace-nowrap">
                      {canTrade && o.role === 'debtor' && o.status === 'pending_acceptance' && <>
                        <Button size="sm" variant="outline" onClick={() => setDeciding({ o, action: 'accept' })}><Check />Aceptar</Button>
                        <Button size="sm" variant="ghost" className="text-destructive" onClick={() => setDeciding({ o, action: 'reject' })}><X />Rechazar</Button>
                      </>}
                      {canTrade && o.role === 'creditor' && ['pending_acceptance', 'open'].includes(o.status) && !o.in_pending_run &&
                        <Button size="sm" variant="ghost" className="text-destructive" onClick={() => setDeciding({ o, action: 'cancel' })}><X />Cancelar</Button>}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
        {q.hasNextPage && <div className="py-2 text-center"><Button variant="outline" size="sm" onClick={() => q.fetchNextPage()} disabled={q.isFetchingNextPage}>Cargar más</Button></div>}
      </CardContent></Card>
      {canTrade && <CreateDialog open={creating} onClose={() => setCreating(false)} />}
      {canTrade && <ImportDialog open={importing} onClose={() => setImporting(false)} />}
      <DecideDialog d={deciding} onClose={() => setDeciding(null)} />
    </div>
  );
}

// ───────────── Registrar (acreedor) ─────────────
function CreateDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const [code, setCode] = useState('');
  const [cp, setCp] = useState<string | null>(null);
  const [asset, setAsset] = useState('');
  const [text, setText] = useState('');
  const [ref, setRef] = useState('');
  const [due, setDue] = useState('');
  const bal = useQuery({ queryKey: ['p-balances'], enabled: open, queryFn: () => papi<{ as_of: string; balances: BalanceRow[] }>('/balances') });
  useEffect(() => { if (open) { setCode(''); setCp(null); setAsset(''); setText(''); setRef(''); setDue(''); look.reset(); m.reset(); } }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
  const a = bal.data?.balances.find((b) => b.asset_id === asset);
  const base = a ? parseUnits(text, a.decimals) : null;
  const look = useMutation({
    mutationFn: () => papi<{ counterparty_code: string; name: string }>(`/counterparties/${encodeURIComponent(code.trim())}`),
    onSuccess: (r) => { setCp(r.name); setCode(r.counterparty_code); },
  });
  const m = useMutation({
    mutationFn: () => papi<ObRow>('/obligations', { method: 'POST', json: {
      counterparty_code: code.trim(), asset_id: asset, amount: base,
      ...(ref.trim() ? { external_ref: ref.trim() } : {}), ...(due ? { due_at: new Date(`${due}T00:00:00Z`).toISOString() } : {}),
    } }),
    onSuccess: () => { KEYS.forEach((k) => qc.invalidateQueries({ queryKey: [k] })); onClose(); },
  });
  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader><DialogTitle>Registrar obligación por cobrar</DialogTitle>
          <DialogDescription>Su contraparte la verá «Por aceptar» y tendrá un plazo para aceptarla o rechazarla. Nada se mueve hasta la compensación.</DialogDescription></DialogHeader>
        <form className="grid gap-4" onSubmit={(e: FormEvent) => { e.preventDefault(); if (cp && base) m.mutate(); }}>
          <Field label="Código de contraparte del deudor" htmlFor="ob-code" hint="Se lo comparte su cliente; tiene la forma 856-XXXX-XXXX.">
            <div className="flex gap-2">
              <Input id="ob-code" autoFocus className="font-mono uppercase" placeholder="856-XXXX-XXXX" value={code} onChange={(e) => { setCode(e.target.value); setCp(null); look.reset(); }} />
              <Button type="button" variant="outline" disabled={code.trim().length < 5 || look.isPending} onClick={() => look.mutate()}><Search />Verificar</Button>
            </div>
          </Field>
          {cp && <p className="rounded-md border border-success/40 bg-success/10 px-3 py-2 text-sm" data-testid="cp-name">Deudor: <b>{cp}</b></p>}
          <ErrorBox error={look.error} />
          {cp && (
            <>
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Activo" htmlFor="ob-asset">
                  <Select id="ob-asset" value={asset} onChange={(e) => setAsset(e.target.value)}>
                    <option value="">Seleccione…</option>
                    {bal.data?.balances.map((b) => <option key={b.asset_id} value={b.asset_id}>{b.symbol} · {b.network}</option>)}
                  </Select>
                </Field>
                <Field label={`Monto${a ? ` en ${a.symbol}` : ''}`} htmlFor="ob-amount" hint={a ? `Hasta ${a.decimals} decimales, con punto.` : undefined}>
                  <Input id="ob-amount" inputMode="decimal" className="font-mono" value={text} onChange={(e) => setText(e.target.value.replace(',', '.'))} aria-invalid={text !== '' && !base} disabled={!a} />
                </Field>
              </div>
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Referencia (OC, factura, CFDI)" htmlFor="ob-ref"><Input id="ob-ref" maxLength={200} value={ref} onChange={(e) => setRef(e.target.value)} /></Field>
                <Field label="Vencimiento (opcional)" htmlFor="ob-due"><Input id="ob-due" type="date" value={due} onChange={(e) => setDue(e.target.value)} /></Field>
              </div>
              {base && a && <p className="text-sm">Registrará <b><Money v={base} decimals={a.decimals} symbol={a.symbol} exact /></b> por cobrar a <b>{cp}</b>.</p>}
            </>
          )}
          <ErrorBox error={m.error} />
          <DialogFooter><Button type="button" variant="outline" onClick={onClose}>Cancelar</Button>
            <Button type="submit" disabled={!cp || !base || m.isPending}>{m.isPending && <Loader2 className="animate-spin" />}Registrar</Button></DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// ───────────── Aceptar, rechazar o cancelar ─────────────
function DecideDialog({ d, onClose }: { d: { o: ObRow; action: 'accept' | 'reject' | 'cancel' } | null; onClose: () => void }) {
  const qc = useQueryClient();
  const { role } = usePortal();
  const [reason, setReason] = useState('');
  const [code, setCode] = useState('');
  const th = useQuery({ queryKey: ['p-thresholds'], enabled: d?.action === 'accept', queryFn: () => papi<{ thresholds: ThresholdRow[] }>('/settings/approval-thresholds') });
  useEffect(() => { setReason(''); setCode(''); m.reset(); }, [d]); // eslint-disable-line react-hooks/exhaustive-deps
  const t = d ? th.data?.thresholds.find((x) => x.asset_id === d.o.asset_id) : undefined;
  const needs2fa = !!d && d.action === 'accept' && !!t && BigInt(d.o.amount) >= BigInt(t.threshold);
  const canApprove = roleAtLeast(role, 'approver');
  const m = useMutation({
    mutationFn: () => papi<ObRow>(`/obligations/${d!.o.id}/${d!.action}`, { method: 'POST', json: d!.action === 'accept' ? (needs2fa ? { code } : {}) : { reason: reason.trim() } }),
    onSuccess: () => { KEYS.forEach((k) => qc.invalidateQueries({ queryKey: [k] })); onClose(); },
  });
  if (!d) return null;
  const { o, action } = d;
  const title = action === 'accept' ? 'Aceptar obligación' : action === 'reject' ? 'Rechazar obligación' : 'Cancelar obligación';
  const ready = action === 'accept' ? (!needs2fa || (canApprove && code.length === 6)) : reason.trim().length >= 5;
  return (
    <Dialog open onOpenChange={(v) => !v && onClose()}>
      <DialogContent>
        <DialogHeader><DialogTitle>{title}</DialogTitle>
          <DialogDescription>{action === 'accept' ? 'Al aceptarla reconoce la deuda: entrará a la siguiente compensación.'
            : action === 'reject' ? 'El acreedor verá su motivo. No se mueve saldo.' : 'Sale de los siguientes cortes. Su contraparte verá el motivo.'}</DialogDescription></DialogHeader>
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1 rounded-md border p-3 text-sm">
          <dt className="text-muted-foreground">{o.role === 'debtor' ? 'Acreedor' : 'Deudor'}</dt><dd>{o.counterparty.name}</dd>
          <dt className="text-muted-foreground">Monto</dt><dd className="font-semibold"><Money v={o.amount} decimals={o.decimals} symbol={o.symbol} exact /></dd>
          <dt className="text-muted-foreground">Referencia</dt><dd className="font-mono text-xs">{o.external_ref ?? '—'}</dd>
          {o.due_at && <><dt className="text-muted-foreground">Vence</dt><dd>{fmtDate(o.due_at)}</dd></>}
        </dl>
        {needs2fa && (canApprove
          ? <Field label="Supera su umbral de aprobación interna: confirme con 2FA"><CodeInput label="Código 2FA para aceptar" autoFocus value={code} onChange={setCode} /></Field>
          : <p className="rounded-md border border-warning/60 bg-warning/10 p-3 text-sm">Supera el umbral de aprobación interna de su empresa ({exactUnits(t!.threshold, o.decimals)} {o.symbol}): debe aceptarla un Aprobador o Administrador.</p>)}
        {action !== 'accept' && <Textarea aria-label="Motivo" autoFocus rows={2} maxLength={500} placeholder="Motivo (mín. 5 caracteres)" value={reason} onChange={(e) => setReason(e.target.value)} />}
        <ErrorBox error={m.error} />
        <DialogFooter><Button variant="outline" onClick={onClose}>Volver</Button>
          <Button variant={action === 'accept' ? 'default' : 'destructive'} disabled={!ready || m.isPending} onClick={() => m.mutate()}>
            {m.isPending && <Loader2 className="animate-spin" />}{action === 'accept' ? 'Aceptar' : action === 'reject' ? 'Rechazar' : 'Cancelar obligación'}</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ───────────── Carga masiva ─────────────
const TEMPLATE = 'contraparte,activo,monto,referencia,vencimiento\r\n856-XXXX-XXXX,USDC-ETH-SEPOLIA,1250.50,FAC-0001,2026-12-31\r\n';

function ImportDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const [file, setFile] = useState<{ name: string; text: string } | null>(null);
  const [res, setRes] = useState<ObImport | null>(null);
  useEffect(() => { if (open) { setFile(null); setRes(null); validate.reset(); commit.reset(); } }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
  const validate = useMutation({
    mutationFn: () => papi<ObImport>('/obligations/import', { method: 'POST', json: { filename: file!.name, csv: file!.text } }),
    onSuccess: setRes,
  });
  const commit = useMutation({
    mutationFn: () => papi<ObImport>(`/obligations/import/${res!.id}/commit`, { method: 'POST', json: {} }),
    onSuccess: (r) => { setRes(r); KEYS.forEach((k) => qc.invalidateQueries({ queryKey: [k] })); },
  });
  const discard = useMutation({ mutationFn: () => papi(`/obligations/import/${res!.id}/discard`, { method: 'POST', json: {} }), onSuccess: onClose });
  const downloadTemplate = () => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob(['﻿' + TEMPLATE], { type: 'text/csv' }));
    a.download = 'plantilla-obligaciones-856.csv'; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };
  const errorsByRow = useMemo(() => res?.errors ?? [], [res]);
  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader><DialogTitle>Cargar obligaciones por CSV</DialogTitle>
          <DialogDescription>Primero se valida sin registrar nada; luego confirma las filas válidas. Columnas: contraparte, activo, monto, referencia, vencimiento (AAAA-MM-DD).</DialogDescription></DialogHeader>
        {!res && (
          <div className="grid gap-3">
            <Button type="button" variant="link" className="h-auto w-fit p-0" onClick={downloadTemplate}><Download />Descargar plantilla</Button>
            <Input aria-label="Archivo CSV" type="file" accept=".csv,text/csv" onChange={async (e) => {
              const f = e.target.files?.[0]; setFile(f ? { name: f.name, text: await f.text() } : null);
            }} />
            <ErrorBox error={validate.error} />
            <DialogFooter><Button variant="outline" onClick={onClose}>Cancelar</Button>
              <Button disabled={!file || validate.isPending} onClick={() => validate.mutate()}>{validate.isPending && <Loader2 className="animate-spin" />}Validar</Button></DialogFooter>
          </div>
        )}
        {res && (
          <div className="grid gap-3 text-sm" data-import={res.id}>
            <p data-testid="import-summary"><b>{res.total_rows}</b> filas · <b className="text-success">{res.valid_rows}</b> válidas · <b className={res.error_rows ? 'text-destructive' : ''}>{res.error_rows}</b> con error</p>
            {!!errorsByRow.length && (
              <div className="max-h-48 overflow-auto rounded-md border">
                <Table aria-label="Errores por fila">
                  <TableHeader><TableRow><TableHead>Fila</TableHead><TableHead>Campo</TableHead><TableHead>Detalle</TableHead></TableRow></TableHeader>
                  <TableBody>{errorsByRow.map((e, i) => <TableRow key={i}><TableCell className="num">{e.row}</TableCell><TableCell>{e.field}</TableCell><TableCell>{e.message}</TableCell></TableRow>)}</TableBody>
                </Table>
              </div>
            )}
            {res.status === 'committed'
              ? <p className="rounded-md border border-success/40 bg-success/10 px-3 py-2">Se registraron {res.created} obligación(es). Sus contrapartes las verán «Por aceptar».</p>
              : res.valid_rows > 0 && <p className="text-muted-foreground">Al confirmar se registran las {res.valid_rows} filas válidas; las filas con error se ignoran. Si alguna deja de proceder, no se registra ninguna.</p>}
            <ErrorBox error={commit.error ?? discard.error} />
            <DialogFooter>
              {res.status === 'validated' ? <>
                <Button variant="outline" onClick={() => discard.mutate()} disabled={discard.isPending}>Descartar</Button>
                <Button disabled={!res.valid_rows || commit.isPending} onClick={() => commit.mutate()}>{commit.isPending && <Loader2 className="animate-spin" />}Confirmar {res.valid_rows}</Button>
              </> : <Button onClick={onClose}>Listo</Button>}
            </DialogFooter>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
