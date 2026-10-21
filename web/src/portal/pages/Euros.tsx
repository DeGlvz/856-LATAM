// Portal fase F1 — recibir euros por SEPA (se acreditan en EURe) y avisos de pago.
// El cliente crea el aviso (referencia única), transfiere con esa referencia y ve el depósito «Recibido, pendiente de
// liberación» hasta que tesorería de 856 lo libera. El servidor valida todo; aquí solo se guía.
import { useEffect, useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Ban, ExternalLink, Info, Loader2, Plus, Send } from 'lucide-react';
import { ApiError, explorerFor, fmtEur, fmtIban, INTENT_STATE, netLabel, papi, roleAtLeast,
  type FiatDepositRow, type FiatInstructions, type PaymentIntent, type PortalRail } from '../api';
import { usePortal } from '../auth';
import { CopyButton, ErrorBox, Field, fmtDate } from '@/components/common';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';

const DEP_V: Record<FiatDepositRow['status'], 'warning' | 'success' | 'destructive'> = { reconciled: 'warning', released: 'success', rejected: 'destructive' };
const notReady = (e: unknown) => e instanceof ApiError && (e.code === 'fiat_not_ready' || e.code === 'fiat_disabled');

function NotReady() {
  return (
    <Card><CardContent className="flex items-start gap-3 py-6 text-sm">
      <Info className="mt-0.5 size-4 text-muted-foreground" />
      <div>La recepción de euros aún no está disponible para su empresa: 856 está terminando el alta de la cuenta con el proveedor regulado. Esta pantalla mostrará el IBAN en cuanto esté listo.</div>
    </CardContent></Card>
  );
}

function Line({ label, value, mono, copy }: { label: string; value: string | null | undefined; mono?: boolean; copy?: string }) {
  return (
    <div className="grid gap-0.5 sm:grid-cols-[10rem_minmax(0,1fr)] sm:items-center">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="flex min-w-0 items-center gap-1"><span className={mono ? 'font-mono text-sm break-all' : 'text-sm'}>{value ?? '—'}</span>{copy && <CopyButton value={copy} />}</div>
    </div>
  );
}

// ═════════════ Recibir euros ═════════════
function RailCard({ rail }: { rail: PortalRail }) {
  const text = [`${rail.label} (${rail.currency})`, ...(rail.fields ?? []).map((f) => `${f.label}: ${f.value}`), `MEMO: ${rail.memo ?? ''}`].join('\n');
  const [done, setDone] = useState(false);
  return (
    <Card data-testid="rail-card" data-rail={rail.rail_id}>
      <CardHeader><CardTitle className="flex flex-wrap items-center gap-2 text-base">{rail.label}
        {rail.recommended_for && <Badge variant="success">{rail.recommended_for}</Badge>}</CardTitle></CardHeader>
      <CardContent className="grid gap-3">
        {rail.fields?.map((f) => <Line key={f.key} label={f.label} value={f.value} mono copy={f.value} />)}
        <Line label="MEMO / referencia" value={rail.memo} mono copy={rail.memo ?? undefined} />
        {rail.settlement_time && <Line label="Tiempo estimado" value={rail.settlement_time} />}
        {(rail.min_amount || rail.max_amount) && <Line label="Montos" value={`${rail.min_amount ?? '0'} – ${rail.max_amount ?? 'sin tope'} ${rail.currency}`} />}
        <p className="text-xs text-muted-foreground">Ponga el MEMO exactamente como aparece, sin nombres ni texto adicional. Tesorería revisa y libera cada depósito.</p>
        <Button variant="outline" className="justify-self-start" onClick={() => navigator.clipboard?.writeText(text).then(() => { setDone(true); setTimeout(() => setDone(false), 1500); })}>
          {done ? 'Copiado' : 'Copiar instrucciones'}</Button>
      </CardContent>
    </Card>
  );
}

// ═════════════ Recibir euros ═════════════
export function ReceiveEuros() {
  const ins = useQuery({ queryKey: ['p-fiat-ins'], queryFn: () => papi<FiatInstructions>('/fiat/instructions'), retry: false });
  const deps = useQuery({ queryKey: ['p-fiat-deps'], queryFn: () => papi<{ items: FiatDepositRow[] }>('/fiat/deposits'), refetchInterval: 30_000 });
  const i = ins.data;
  return (
    <div className="mx-auto grid max-w-6xl grid-cols-[minmax(0,1fr)] gap-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Recibir euros</h1>
        <p className="text-sm text-muted-foreground">Transfiera euros por SEPA desde su banco: se reciben en su cuenta como EURe (1 EURe = 1 €) cuando tesorería los libera.</p>
      </div>
      {notReady(ins.error) ? <NotReady /> : <ErrorBox error={ins.error} />}
      {ins.isPending ? <Skeleton className="h-48" /> : i && i.iban && (!i.eur_rail || i.eur_rail.enabled) && (
        <div className="grid gap-4 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
          <Card data-testid="fiat-instructions">
            <CardHeader><CardTitle className="text-base">Datos para la transferencia SEPA</CardTitle></CardHeader>
            <CardContent className="grid gap-3">
              <Line label="Beneficiario" value={i.beneficiary} copy={i.beneficiary ?? undefined} />
              <Line label="IBAN" value={fmtIban(i.iban)} mono copy={i.iban} />
              <Line label="BIC" value={i.bic} mono copy={i.bic ?? undefined} />
              <Line label="Moneda" value="EUR (SEPA)" />
              <Line label="Se acredita como" value={`${i.asset_id} · ${netLabel(i.network ?? '')}`} />
              <Line label="Concepto" value="La referencia de su aviso de pago (856-XXXX-XXXX-NNN), sin texto adicional" />
            </CardContent>
          </Card>
          <Card>
            <CardHeader><CardTitle className="text-base">Cómo hacerlo</CardTitle></CardHeader>
            <CardContent className="grid gap-3 text-sm">
              <ol className="grid list-decimal gap-2 pl-5">{(i.steps ?? []).map((s) => <li key={s}>{s}</li>)}</ol>
              <p className="text-xs text-muted-foreground">Sin aviso, el concepto puede llevar su código de contraparte {i.counterparty_code && <code className="font-mono">{i.counterparty_code}</code>}; el depósito queda en revisión de tesorería si no se puede asignar.</p>
              <Button asChild variant="outline" className="justify-self-start"><Link to="/avisos"><Plus />Crear aviso de pago</Link></Button>
            </CardContent>
          </Card>
        </div>
      )}
      {i?.notice && <div role="status" className="rounded-md border bg-muted/40 px-3 py-2 text-sm" data-testid="fiat-notice">{i.notice}</div>}
      {i?.eur_rail && !i.eur_rail.enabled && (
        <Card data-testid="rail-maintenance"><CardContent className="flex items-start gap-3 py-4 text-sm"><Info className="mt-0.5 size-4 text-muted-foreground" />
          <div>{i.eur_rail.maintenance_message ?? 'La recepción de euros por SEPA automático está temporalmente en pausa.'}</div></CardContent></Card>
      )}
      {i?.unavailable_rails.filter((u) => u.rail_id !== 'monerium-eur').map((u) => (
        <Card key={u.rail_id} data-testid="rail-maintenance"><CardContent className="flex items-start gap-3 py-4 text-sm"><Info className="mt-0.5 size-4 text-muted-foreground" />
          <div><strong>{u.label}</strong>: {u.maintenance_message}{u.alternative && <> Alterno sugerido: <strong>{u.alternative.label}</strong>.</>}</div></CardContent></Card>
      ))}
      {i?.active_rails.filter((r) => r.kind === 'manual').map((r) => <RailCard key={r.rail_id} rail={r} />)}
      <div className="grid gap-2">
        <h2 className="text-base font-semibold">Depósitos en euros</h2>
        <ErrorBox error={deps.error} />
        <Card className="py-2"><CardContent className="px-3">
          {deps.isPending ? <Skeleton className="h-24" /> : (
            <div className="overflow-x-auto">
              <Table aria-label="Depósitos en euros">
                <TableHeader><TableRow><TableHead>Recibido</TableHead><TableHead className="text-right">Monto</TableHead><TableHead>Referencia</TableHead><TableHead>Ordenante</TableHead><TableHead>Estado</TableHead><TableHead>Acuñación</TableHead></TableRow></TableHeader>
                <TableBody>
                  {!deps.data?.items.length && <TableRow><TableCell colSpan={6} className="py-8 text-center text-muted-foreground">Aún no hay depósitos en euros.</TableCell></TableRow>}
                  {deps.data?.items.map((d) => (
                    <TableRow key={d.id} data-fiat-deposit={d.id}>
                      <TableCell className="text-xs whitespace-nowrap">{fmtDate(d.received_at)}</TableCell>
                      <TableCell className="text-right font-medium tabular-nums whitespace-nowrap">{fmtEur(d.amount_eur)}</TableCell>
                      <TableCell><code className="font-mono text-xs">{d.intent_reference ?? d.reference ?? '—'}</code></TableCell>
                      <TableCell className="text-sm">{d.payer_name ?? '—'}</TableCell>
                      <TableCell><Badge variant={DEP_V[d.status]} data-testid="fiat-dep-status">{d.status_label}</Badge>{d.status === 'rejected' && d.reason && <div className="mt-1 text-xs text-muted-foreground">{d.reason}</div>}</TableCell>
                      <TableCell>{d.tx_hash ? <a className="inline-flex items-center gap-1 text-xs text-primary" href={`${explorerFor(d.network)}/tx/${d.tx_hash}`} target="_blank" rel="noreferrer noopener">{d.tx_hash.slice(0, 10)}…<ExternalLink className="size-3" /></a> : '—'}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent></Card>
      </div>
    </div>
  );
}

// ═════════════ Avisos de pago ═════════════
export function PaymentIntents() {
  const { role } = usePortal();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['p-fiat-intents'], queryFn: () => papi<{ items: PaymentIntent[] }>('/fiat/payment-intents'), refetchInterval: 60_000 });
  const [creating, setCreating] = useState(false);
  const [created, setCreated] = useState<PaymentIntent | null>(null);
  const [cancelling, setCancelling] = useState<PaymentIntent | null>(null);
  const [reporting, setReporting] = useState<PaymentIntent | null>(null);
  const canCreate = roleAtLeast(role, 'operator');
  const cancel = useMutation({
    mutationFn: (id: string) => papi<PaymentIntent>(`/fiat/payment-intents/${id}/cancel`, { method: 'POST', json: {} }),
    onSuccess: () => { setCancelling(null); qc.invalidateQueries({ queryKey: ['p-fiat-intents'] }); },
  });
  return (
    <div className="mx-auto grid max-w-6xl grid-cols-[minmax(0,1fr)] gap-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Avisos de pago</h1>
          <p className="text-sm text-muted-foreground">Avise a 856 de cada transferencia SEPA: la referencia del aviso, puesta en el concepto, asigna el depósito a su empresa automáticamente.</p>
        </div>
        {canCreate && <Button onClick={() => setCreating(true)}><Plus />Nuevo aviso</Button>}
      </div>
      <ErrorBox error={q.error ?? cancel.error} />
      <Card className="py-2"><CardContent className="px-3">
        {q.isPending ? <Skeleton className="h-24" /> : (
          <div className="overflow-x-auto">
            <Table aria-label="Avisos de pago">
              <TableHeader><TableRow><TableHead>Referencia</TableHead><TableHead className="text-right">Monto</TableHead><TableHead>Fecha estimada</TableHead><TableHead>Nota</TableHead><TableHead>Estado</TableHead><TableHead>Vence</TableHead><TableHead /></TableRow></TableHeader>
              <TableBody>
                {!q.data?.items.length && <TableRow><TableCell colSpan={7} className="py-8 text-center text-muted-foreground">Aún no hay avisos.</TableCell></TableRow>}
                {q.data?.items.map((p) => (
                  <TableRow key={p.id} data-intent={p.reference}>
                    <TableCell><div className="flex items-center gap-1"><code className="font-mono text-sm">{p.reference}</code><CopyButton value={p.reference} /></div></TableCell>
                    <TableCell className="text-right font-medium tabular-nums whitespace-nowrap">{fmtEur(p.expected_amount_eur)}</TableCell>
                    <TableCell className="text-xs">{p.expected_date ?? '—'}</TableCell>
                    <TableCell className="max-w-56 truncate text-sm" title={p.note ?? undefined}>{p.note ?? '—'}</TableCell>
                    <TableCell><Badge variant={INTENT_STATE[p.status].v}>{INTENT_STATE[p.status].t}</Badge>
                      {p.status === 'open' && p.reported_at && <div className="mt-1 text-xs text-muted-foreground" data-testid="intent-reported">Pago reportado{p.reported_date && ` (${p.reported_date})`}</div>}</TableCell>
                    <TableCell className="text-xs text-muted-foreground whitespace-nowrap">{fmtDate(p.expires_at)}</TableCell>
                    <TableCell className="text-right whitespace-nowrap">
                      {p.status === 'open' && canCreate && <Button size="sm" variant="outline" onClick={() => setReporting(p)}><Send />{p.reported_at ? 'Editar reporte' : 'Reportar pago'}</Button>}
                      {p.status === 'open' && canCreate && <Button size="sm" variant="ghost" className="text-destructive" onClick={() => setCancelling(p)}><Ban />Cancelar</Button>}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent></Card>
      <NewIntentDialog open={creating} onClose={() => setCreating(false)} onCreated={(p) => { setCreating(false); setCreated(p); }} />
      <Dialog open={!!created} onOpenChange={(v) => !v && setCreated(null)}>
        <DialogContent>
          <DialogHeader><DialogTitle>Aviso creado</DialogTitle>
            <DialogDescription>Ponga esta referencia como concepto de su transferencia SEPA de {created && fmtEur(created.expected_amount_eur)}, sin texto adicional.</DialogDescription></DialogHeader>
          <div className="flex items-center justify-center gap-2 rounded-md border bg-muted/40 p-4"><code className="font-mono text-lg font-semibold" data-testid="intent-reference">{created?.reference}</code>{created && <CopyButton value={created.reference} />}</div>
          <p className="text-xs text-muted-foreground">Vence el {created && fmtDate(created.expires_at)}. Si transfiere otro monto o después del vencimiento, tesorería lo revisará antes de acreditarlo.</p>
          <DialogFooter><Button asChild variant="outline"><Link to="/euros">Ver datos bancarios</Link></Button><Button onClick={() => setCreated(null)}>Listo</Button></DialogFooter>
        </DialogContent>
      </Dialog>
      <ReportIntentDialog intent={reporting} onClose={() => setReporting(null)} />
      <Dialog open={!!cancelling} onOpenChange={(v) => !v && setCancelling(null)}>
        <DialogContent>
          <DialogHeader><DialogTitle>Cancelar aviso</DialogTitle>
            <DialogDescription>Si después llega una transferencia con esta referencia, quedará en revisión de tesorería.</DialogDescription></DialogHeader>
          <code className="font-mono">{cancelling?.reference}</code>
          <ErrorBox error={cancel.error} />
          <DialogFooter><Button variant="outline" onClick={() => setCancelling(null)}>Volver</Button>
            <Button variant="destructive" disabled={cancel.isPending} onClick={() => cancel.mutate(cancelling!.id)}>Cancelar aviso</Button></DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function ReportIntentDialog({ intent, onClose }: { intent: PaymentIntent | null; onClose: () => void }) {
  const qc = useQueryClient();
  const [date, setDate] = useState('');
  const [bankRef, setBankRef] = useState('');
  const [note, setNote] = useState('');
  useEffect(() => {
    if (intent) { setDate(intent.reported_date ?? new Date().toISOString().slice(0, 10)); setBankRef(intent.reported_bank_ref ?? ''); setNote(intent.reported_note ?? ''); m.reset(); }
  }, [intent]); // eslint-disable-line react-hooks/exhaustive-deps
  const m = useMutation({
    mutationFn: () => papi<PaymentIntent>(`/fiat/payment-intents/${intent!.id}/report`, {
      method: 'POST', json: { transfer_date: date, ...(bankRef.trim() ? { bank_reference: bankRef.trim() } : {}), ...(note.trim() ? { note: note.trim() } : {}) } }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['p-fiat-intents'] }); onClose(); },
  });
  return (
    <Dialog open={!!intent} onOpenChange={(v) => !v && onClose()}>
      <DialogContent>
        <DialogHeader><DialogTitle>Reportar pago</DialogTitle>
          <DialogDescription>Avise a 856 que ya realizó la transferencia SEPA. Es solo informativo: el saldo se acredita cuando el depósito llega y tesorería lo libera.</DialogDescription></DialogHeader>
        <code className="font-mono">{intent?.reference}</code>
        <form className="grid gap-4" onSubmit={(e: FormEvent) => { e.preventDefault(); if (date) m.mutate(); }}>
          <Field label="Fecha de la transferencia" htmlFor="fr-date"><Input id="fr-date" type="date" required value={date} onChange={(e) => setDate(e.target.value)} /></Field>
          <Field label="Referencia bancaria (opcional)" htmlFor="fr-ref" hint="El identificador de la operación que le da su banco."><Input id="fr-ref" maxLength={100} value={bankRef} onChange={(e) => setBankRef(e.target.value)} /></Field>
          <Field label="Nota (opcional)" htmlFor="fr-note"><Input id="fr-note" maxLength={300} value={note} onChange={(e) => setNote(e.target.value)} /></Field>
          <ErrorBox error={m.error} />
          <DialogFooter><Button type="button" variant="outline" onClick={onClose}>Volver</Button>
            <Button type="submit" disabled={!date || m.isPending}>{m.isPending && <Loader2 className="animate-spin" />}Reportar pago</Button></DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function NewIntentDialog({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: (p: PaymentIntent) => void }) {
  const qc = useQueryClient();
  const [amount, setAmount] = useState('');
  const [date, setDate] = useState('');
  const [note, setNote] = useState('');
  useEffect(() => { if (open) { setAmount(''); setDate(''); setNote(''); m.reset(); } }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
  const clean = amount.trim().replace(/\s/g, '');
  const valid = /^\d{1,15}(\.\d{1,2})?$/.test(clean) && Number(clean) > 0;
  const m = useMutation({
    mutationFn: () => papi<PaymentIntent>('/fiat/payment-intents', { method: 'POST', json: { amount: clean, ...(date ? { expected_date: date } : {}), ...(note.trim() ? { note: note.trim() } : {}) } }),
    onSuccess: (p) => { qc.invalidateQueries({ queryKey: ['p-fiat-intents'] }); onCreated(p); },
  });
  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent>
        <DialogHeader><DialogTitle>Nuevo aviso de pago</DialogTitle>
          <DialogDescription>Indique el monto exacto que transferirá. Recibirá una referencia para el concepto SEPA.</DialogDescription></DialogHeader>
        <form className="grid gap-4" onSubmit={(e: FormEvent) => { e.preventDefault(); if (valid) m.mutate(); }}>
          <Field label="Monto (EUR)" htmlFor="fi-amount" hint="Con punto decimal y hasta 2 decimales, p. ej. 1250.50">
            <Input id="fi-amount" autoFocus inputMode="decimal" placeholder="0.00" value={amount} onChange={(e) => setAmount(e.target.value)} aria-invalid={amount !== '' && !valid} /></Field>
          <Field label="Fecha estimada de la transferencia (opcional)" htmlFor="fi-date"><Input id="fi-date" type="date" value={date} onChange={(e) => setDate(e.target.value)} /></Field>
          <Field label="Nota (opcional)" htmlFor="fi-note" hint="Para su control, p. ej. el número de factura."><Input id="fi-note" maxLength={300} value={note} onChange={(e) => setNote(e.target.value)} /></Field>
          <ErrorBox error={m.error} />
          <DialogFooter><Button type="button" variant="outline" onClick={onClose}>Cancelar</Button>
            <Button type="submit" disabled={!valid || m.isPending}>{m.isPending && <Loader2 className="animate-spin" />}Crear aviso</Button></DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
