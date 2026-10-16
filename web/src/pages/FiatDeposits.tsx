// Consola fase F1 — depósitos en euros (SEPA → EURe, tesorería única con Monerium).
// Estado del alta con el proveedor, bandeja de conciliación y liberación/rechazo por un tesorero con 2FA.
// El cliente origina los avisos de pago; aquí solo se concilia, se libera o se rechaza.
import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Ban, CheckCheck, ExternalLink, FlaskConical, Landmark, Loader2, RefreshCw } from 'lucide-react';
import { api, type ClientRow } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useMeta } from '@/components/EnvBanner';
import { CopyButton, ErrorBox, Field, fmtDate } from '@/components/common';
import { StepUpDialog } from '@/components/StepUpDialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';

type FStatus = 'received' | 'minted' | 'reconciled' | 'released' | 'review' | 'rejected';
interface FiatStatus {
  enabled: boolean; provider: 'monerium' | 'mock' | null; live: boolean; live_switch: boolean; mode: string; network: string;
  account: null | { id: string; status: 'pending_link' | 'linked' | 'iban_requested' | 'active' | 'closed'; iban: string | null; bic: string | null; beneficiary: string | null; address: string; network: string; provider_state: string | null; updated_at: string };
  last_poll_at: string | null; last_error: string | null; provider_calls: number; queue: { reconciled: number; review: number; in_flight: number };
}
interface FiatDeposit {
  id: string; provider_order_id: string; amount_eur: string; asset_id: string; reference: string | null; payer_iban_masked: string | null; payer_name: string | null;
  network: string; tx_hash: string | null; confirmations: number; client_id: string | null; client_name: string | null; intent_reference: string | null;
  match_rule: 'intent' | 'counterparty' | 'manual' | null; review_reason: string | null; status: FStatus; released_by: string | null; released_at: string | null;
  reason: string | null; received_at: string;
}
const ST: Record<FStatus, { t: string; v: 'warning' | 'success' | 'destructive' | 'secondary' | 'outline' | 'default' }> = {
  received: { t: 'Recibida (sin acuñar)', v: 'secondary' }, minted: { t: 'Acuñada, por verificar', v: 'default' },
  reconciled: { t: 'Conciliada', v: 'warning' }, review: { t: 'En revisión', v: 'destructive' },
  released: { t: 'Liberada', v: 'success' }, rejected: { t: 'Rechazada', v: 'outline' },
};
const ACC: Record<string, string> = { pending_link: 'Dirección sin ligar', linked: 'Dirección ligada', iban_requested: 'IBAN solicitado', active: 'Activa', closed: 'Cerrada' };
const RULE: Record<string, string> = { intent: 'Aviso de pago', counterparty: 'Código de contraparte', manual: 'Asignación manual' };
const EXPL: Record<string, string> = { 'base-mainnet': 'https://basescan.org', 'base-sepolia': 'https://sepolia.basescan.org' };
const eur = (s: string) => { const [i, d = ''] = s.split('.'); return `${i.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}.${d.padEnd(2, '0').slice(0, 2)} €`; };

export function FiatDeposits() {
  const { can } = useAuth();
  const meta = useMeta();
  const qc = useQueryClient();
  const [filter, setFilter] = useState<FStatus | ''>('');
  const [setup, setSetup] = useState(false);
  const [releasing, setReleasing] = useState<FiatDeposit | null>(null);
  const [rejecting, setRejecting] = useState<FiatDeposit | null>(null);
  const [simulating, setSimulating] = useState(false);
  const status = useQuery({ queryKey: ['fiat-status'], queryFn: () => api<FiatStatus>('/console/fiat/status'), refetchInterval: 30_000 });
  const list = useQuery({
    queryKey: ['fiat-deposits', filter],
    queryFn: () => api<{ items: FiatDeposit[] }>(`/console/fiat/deposits?limit=100${filter ? `&status=${filter}` : ''}`), refetchInterval: 30_000,
  });
  const refresh = () => { qc.invalidateQueries({ queryKey: ['fiat-status'] }); qc.invalidateQueries({ queryKey: ['fiat-deposits'] }); };
  const poll = useMutation({ mutationFn: () => api('/console/fiat/poll', { method: 'POST', json: {} }), onSettled: refresh });
  const s = status.data;
  const tes = can('tesorero');
  const sandbox = meta.data?.environment === 'sandbox';

  return (
    <div className="mx-auto grid max-w-7xl grid-cols-[minmax(0,1fr)] gap-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Depósitos en euros</h1>
          <p className="text-sm text-muted-foreground">SEPA → EURe con proveedor regulado. Se concilian solos; solo un tesorero con 2FA libera saldo al cliente.</p>
        </div>
        <div className="flex flex-wrap gap-2">
          {tes && s?.enabled && sandbox && s.account?.status === 'active' && <Button variant="outline" onClick={() => setSimulating(true)}><FlaskConical />Simular depósito</Button>}
          {tes && s?.enabled && <Button variant="outline" disabled={poll.isPending} onClick={() => poll.mutate()}>{poll.isPending ? <Loader2 className="animate-spin" /> : <RefreshCw />}Conciliar ahora</Button>}
        </div>
      </div>
      <ErrorBox error={status.error ?? poll.error} />

      {status.isPending ? <Skeleton className="h-28" /> : s && (
        <Card data-testid="fiat-status">
          <CardHeader><CardTitle className="flex flex-wrap items-center gap-2 text-base"><Landmark className="size-4" />Cuenta con el proveedor
            {s.enabled ? <Badge variant={s.live ? 'success' : 'secondary'}>{s.live ? 'Monerium (real)' : 'Proveedor simulado'}</Badge> : <Badge variant="outline">Apagado</Badge>}
            {s.account && <Badge variant={s.account.status === 'active' ? 'success' : 'warning'}>{ACC[s.account.status]}</Badge>}</CardTitle></CardHeader>
          <CardContent className="grid gap-3 text-sm">
            {!s.enabled && <p className="text-muted-foreground">La entrada de fiat está apagada en este despliegue (FIAT_LIVE_ENABLED=false). Se enciende cuando el proveedor apruebe el perfil.</p>}
            {s.enabled && !s.account && (
              <div className="flex flex-wrap items-center justify-between gap-3">
                <p className="text-muted-foreground">Sin alta. El alta reserva una dirección HD de 856 en {s.network}, la liga al perfil (firma de propiedad, sin gas) y solicita el IBAN.</p>
                {tes && <Button onClick={() => setSetup(true)}>Dar de alta</Button>}
              </div>
            )}
            {s.account && (
              <div className="grid gap-2 md:grid-cols-2">
                <div><div className="text-xs text-muted-foreground">IBAN</div><div className="flex items-center gap-1 font-mono">{s.account.iban ? s.account.iban.replace(/(.{4})/g, '$1 ').trim() : 'en trámite'}{s.account.iban && <CopyButton value={s.account.iban} />}</div></div>
                <div><div className="text-xs text-muted-foreground">Beneficiario</div><div>{s.account.beneficiary ?? '—'}</div></div>
                <div><div className="text-xs text-muted-foreground">Dirección de tesorería ({s.account.network})</div><div className="flex items-center gap-1 font-mono text-xs break-all">{s.account.address}<CopyButton value={s.account.address} /></div></div>
                <div><div className="text-xs text-muted-foreground">Último sondeo</div><div>{s.last_poll_at ? fmtDate(s.last_poll_at) : '—'}{s.last_error && <span className="ml-2 text-destructive">{s.last_error}</span>}</div></div>
              </div>
            )}
            {s.account && s.account.status !== 'active' && tes && <Button variant="outline" className="justify-self-start" onClick={() => setSetup(true)}>Continuar alta / refrescar IBAN</Button>}
            {s.enabled && <div className="flex flex-wrap gap-2 text-xs"><Badge variant="warning">{s.queue.reconciled} por liberar</Badge><Badge variant="destructive">{s.queue.review} en revisión</Badge><Badge variant="secondary">{s.queue.in_flight} en curso</Badge></div>}
          </CardContent>
        </Card>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <label htmlFor="fiat-filter" className="text-sm text-muted-foreground">Estado</label>
        <Select id="fiat-filter" aria-label="Filtrar por estado" className="w-56" value={filter} onChange={(e) => setFilter(e.target.value as FStatus | '')}>
          <option value="">Todos</option>{(Object.keys(ST) as FStatus[]).map((k) => <option key={k} value={k}>{ST[k].t}</option>)}
        </Select>
      </div>
      <ErrorBox error={list.error} />
      <Card className="py-2"><CardContent className="px-3">
        {list.isPending ? <Skeleton className="h-24" /> : (
          <div className="overflow-x-auto">
            <Table aria-label="Depósitos en euros">
              <TableHeader><TableRow><TableHead>Recibido</TableHead><TableHead className="text-right">Monto</TableHead><TableHead>Concepto</TableHead><TableHead>Ordenante</TableHead><TableHead>Cliente</TableHead><TableHead>Estado</TableHead><TableHead>Acuñación</TableHead><TableHead /></TableRow></TableHeader>
              <TableBody>
                {!list.data?.items.length && <TableRow><TableCell colSpan={8} className="py-8 text-center text-muted-foreground">Sin depósitos en euros.</TableCell></TableRow>}
                {list.data?.items.map((d) => (
                  <TableRow key={d.id} data-fiat-deposit={d.id}>
                    <TableCell className="text-xs whitespace-nowrap">{fmtDate(d.received_at)}</TableCell>
                    <TableCell className="text-right font-medium tabular-nums whitespace-nowrap">{eur(d.amount_eur)}</TableCell>
                    <TableCell className="max-w-48 whitespace-normal"><code className="font-mono text-xs break-all">{d.reference ?? '—'}</code></TableCell>
                    <TableCell className="text-xs">{d.payer_name ?? '—'}<div className="text-muted-foreground">{d.payer_iban_masked}</div></TableCell>
                    <TableCell className="text-sm">{d.client_name ?? <span className="text-muted-foreground">sin asignar</span>}{d.match_rule && <div className="text-xs text-muted-foreground">{RULE[d.match_rule]}</div>}</TableCell>
                    <TableCell><Badge variant={ST[d.status].v}>{ST[d.status].t}</Badge>
                      {d.status === 'review' && d.review_reason && <div className="mt-1 max-w-64 text-xs whitespace-normal text-muted-foreground">{d.review_reason}</div>}
                      {(d.status === 'released' || d.status === 'rejected') && <div className="mt-1 max-w-64 text-xs break-words whitespace-normal text-muted-foreground">{d.released_by}{d.reason && ` · ${d.reason}`}</div>}</TableCell>
                    <TableCell className="text-xs">{d.tx_hash ? <a className="inline-flex items-center gap-1 text-primary" href={`${EXPL[d.network] ?? EXPL['base-mainnet']}/tx/${d.tx_hash}`} target="_blank" rel="noreferrer noopener">{d.tx_hash.slice(0, 10)}…<ExternalLink className="size-3" /></a> : '—'}{d.tx_hash && <div className="text-muted-foreground">{d.confirmations} conf.</div>}</TableCell>
                    <TableCell className="text-right whitespace-nowrap">
                      {tes && (d.status === 'reconciled' || d.status === 'review') && <Button size="sm" variant="outline" onClick={() => setReleasing(d)}><CheckCheck />Liberar</Button>}
                      {tes && ['received', 'minted', 'reconciled', 'review'].includes(d.status) && <Button size="sm" variant="ghost" className="text-destructive" onClick={() => setRejecting(d)}><Ban />Rechazar</Button>}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent></Card>

      <StepUpDialog open={setup} title="Alta con el proveedor de fiat" confirmLabel="Dar de alta"
        description="Reserva la dirección HD de tesorería, verifica el contrato EURe del proveedor contra el catálogo, liga la dirección (firma de mensaje, sin gas) y solicita el IBAN. Se puede repetir para refrescar el estado."
        onConfirm={(code) => api('/console/fiat/setup', { method: 'POST', json: { code } }).then(refresh)} onClose={() => setSetup(false)} />
      <ReleaseDialog dep={releasing} onClose={() => setReleasing(null)} onDone={refresh} />
      <RejectDialog dep={rejecting} onClose={() => setRejecting(null)} onDone={refresh} />
      <SimulateDialog open={simulating} onClose={() => setSimulating(false)} onDone={refresh} />
    </div>
  );
}

function ReleaseDialog({ dep, onClose, onDone }: { dep: FiatDeposit | null; onClose: () => void; onDone: () => void }) {
  const review = dep?.status === 'review';
  const [q, setQ] = useState('');
  const [clientId, setClientId] = useState('');
  const [reason, setReason] = useState('');
  const clients = useQuery({
    queryKey: ['fiat-clients', q], enabled: !!dep && review,
    queryFn: () => api<{ clients: ClientRow[] }>(`/clients?status=active&limit=20${q.trim() ? `&q=${encodeURIComponent(q.trim())}` : ''}`).then((r) => r.clients),
  });
  const reasonOk = reason.trim().length >= 5;
  return (
    <StepUpDialog open={!!dep} title={review ? 'Asignar y liberar' : 'Liberar depósito'} confirmLabel="Liberar"
      canSubmit={!review || (!!clientId && reasonOk)}
      description={dep && <>Acredita <strong>{eur(dep.amount_eur)}</strong> en {dep.asset_id} al saldo disponible {review ? 'del cliente que elija' : <>de <strong>{dep.client_name}</strong></>}. Queda en la bitácora con su nombre.</>}
      onConfirm={(code) => api(`/console/fiat/deposits/${dep!.id}/release`, { method: 'POST', json: { code, ...(review ? { client_id: clientId, reason: reason.trim() } : {}) } }).then(onDone)}
      onClose={() => { setQ(''); setClientId(''); setReason(''); onClose(); }}>
      {review && (
        <div className="grid gap-3">
          {dep?.review_reason && <p className="rounded-md border bg-muted/40 p-2 text-xs">En revisión: {dep.review_reason}</p>}
          <Field label="Buscar cliente" htmlFor="fr-q"><Input id="fr-q" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Nombre o id externo" /></Field>
          <Field label="Cliente" htmlFor="fr-client">
            <Select id="fr-client" aria-label="Cliente a acreditar" value={clientId} onChange={(e) => setClientId(e.target.value)}>
              <option value="">Elija…</option>{(clients.data ?? []).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </Select></Field>
          <Field label="Motivo de la asignación" htmlFor="fr-reason" hint="Mín. 5 caracteres; queda en la bitácora."><Input id="fr-reason" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} /></Field>
        </div>
      )}
    </StepUpDialog>
  );
}

function RejectDialog({ dep, onClose, onDone }: { dep: FiatDeposit | null; onClose: () => void; onDone: () => void }) {
  const [reason, setReason] = useState('');
  return (
    <StepUpDialog open={!!dep} title="Rechazar depósito" confirmLabel="Rechazar" destructive canSubmit={reason.trim().length >= 5}
      description={dep && <>No se acredita a ningún cliente. Los {eur(dep.amount_eur)} quedan en la tesorería fiat para su devolución por fuera de este flujo.</>}
      onConfirm={(code) => api(`/console/fiat/deposits/${dep!.id}/reject`, { method: 'POST', json: { code, reason: reason.trim() } }).then(onDone)}
      onClose={() => { setReason(''); onClose(); }}>
      <Field label="Motivo" htmlFor="fj-reason" hint="Mín. 5 caracteres; lo ve el cliente si el depósito estaba asignado a él."><Input id="fj-reason" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} /></Field>
    </StepUpDialog>
  );
}

/** Solo sandbox: el proveedor simulado registra una transferencia entrante (el hash debe ser una transferencia real de EURe a la tesorería). */
function SimulateDialog({ open, onClose, onDone }: { open: boolean; onClose: () => void; onDone: () => void }) {
  const [amount, setAmount] = useState(''), [memo, setMemo] = useState(''), [payer, setPayer] = useState(''), [hash, setHash] = useState('');
  const m = useMutation({
    mutationFn: () => api('/console/fiat/simulate', { method: 'POST', json: { amount: amount.trim(), memo: memo.trim() || undefined, payer_name: payer.trim() || undefined, tx_hash: hash.trim() || undefined } }),
    onSuccess: () => { onDone(); onClose(); },
  });
  const valid = /^\d{1,15}(\.\d{1,2})?$/.test(amount.trim()) && (!hash.trim() || /^0x[0-9a-fA-F]{64}$/.test(hash.trim()));
  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent>
        <DialogHeader><DialogTitle>Simular depósito SEPA (sandbox)</DialogTitle>
          <DialogDescription>El proveedor simulado registra la orden. Sin hash queda «recibida»; con el hash de una transferencia de EURe a la tesorería, se verifica y concilia.</DialogDescription></DialogHeader>
        <form className="grid gap-3" onSubmit={(e: FormEvent) => { e.preventDefault(); if (valid) m.mutate(); }}>
          <Field label="Monto (EUR)" htmlFor="fs-amount"><Input id="fs-amount" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="100.00" /></Field>
          <Field label="Concepto" htmlFor="fs-memo" hint="Referencia del aviso o código de contraparte."><Input id="fs-memo" value={memo} onChange={(e) => setMemo(e.target.value)} /></Field>
          <Field label="Ordenante" htmlFor="fs-payer"><Input id="fs-payer" value={payer} onChange={(e) => setPayer(e.target.value)} /></Field>
          <Field label="Hash de acuñación (opcional)" htmlFor="fs-hash"><Input id="fs-hash" className="font-mono text-xs" value={hash} onChange={(e) => setHash(e.target.value)} placeholder="0x…" /></Field>
          <ErrorBox error={m.error} />
          <DialogFooter><Button type="button" variant="outline" onClick={onClose}>Cancelar</Button><Button type="submit" disabled={!valid || m.isPending}>Simular</Button></DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
