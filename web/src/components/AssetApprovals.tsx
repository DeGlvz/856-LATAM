// Multi-red en Aprobaciones: solicitudes de activos del Ejecutivo y depósitos en revisión (activo no habilitado).
// Ambas decisiones son del Tesorero con 2FA; quien solicitó no aprueba.
import { useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Loader2, X } from 'lucide-react';
import { api, REQUEST_ACTION, type AssetRequest, type DepositRow } from '@/lib/api';
import { ago, shortHex } from '@/lib/amount';
import { useAuth } from '@/lib/auth';
import { useAssets, useNetworks } from '@/lib/hooks';
import { Amount, ErrorBox, fmtDate } from '@/components/common';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';

const REFRESH = ['asset-requests', 'client-assets', 'deposits', 'summary', 'held-deposits'];
const codeInput = (label: string, v: string, set: (v: string) => void) => (
  <Input aria-label={label} inputMode="numeric" autoComplete="one-time-code" maxLength={6} placeholder="Código 2FA"
    className="h-9 w-32 text-center font-mono tracking-widest" value={v} onChange={(e) => set(e.target.value.replace(/\D/g, ''))} />
);

export function AssetRequestsCard() {
  const q = useQuery({ queryKey: ['asset-requests', 'pending'], queryFn: () => api<{ requests: AssetRequest[] }>('/asset-requests?status=pending').then((r) => r.requests), refetchInterval: 15_000 });
  if (!q.data?.length) return null;
  return (
    <Card data-section="asset-requests">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">Solicitudes de activos <Badge variant="warning">{q.data.length}</Badge></CardTitle>
        <CardDescription>El ejecutivo pidió habilitar, pasar a solo salida o deshabilitar un activo para un cliente. Decide un tesorero distinto, con 2FA.</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-3">
        {q.data.map((r) => <RequestRow key={r.id} r={r} />)}
      </CardContent>
    </Card>
  );
}

function RequestRow({ r }: { r: AssetRequest }) {
  const { operator } = useAuth();
  const nets = useNetworks();
  const qc = useQueryClient();
  const [code, setCode] = useState('');
  const [reason, setReason] = useState('');
  const [rejecting, setRejecting] = useState(false);
  const done = () => REFRESH.forEach((k) => qc.invalidateQueries({ queryKey: [k] }));
  const approve = useMutation({ mutationFn: () => api(`/asset-requests/${r.id}/approve`, { method: 'POST', json: { code } }), onSuccess: done });
  const reject = useMutation({ mutationFn: () => api(`/asset-requests/${r.id}/reject`, { method: 'POST', json: { reason: reason.trim() } }), onSuccess: done });
  const own = !!operator && r.requested_by_operator === operator.id;
  return (
    <div data-request={r.id} className="grid gap-3 rounded-lg border p-3 md:grid-cols-[minmax(0,1fr)_minmax(0,22rem)]">
      <div className="grid gap-1 text-sm">
        <div className="flex flex-wrap items-center gap-2">
          <b>{REQUEST_ACTION[r.action]}</b> <span className="font-mono text-xs">{r.asset_id}</span>
          <Badge variant="outline">{nets.label(r.network)}</Badge>
          <Link to={`/clientes/${r.client_id}`} className="font-medium hover:underline">{r.client_name}</Link>
        </div>
        <div className="text-xs text-muted-foreground">«{r.reason}»</div>
        <div className="text-xs text-muted-foreground">Solicitó {r.requested_by} · hace {ago(r.created_at)}</div>
      </div>
      <div className="grid gap-2 rounded-md border border-warning/60 bg-warning/5 p-3 text-sm">
        {own ? <p className="text-muted-foreground">Usted lo solicitó: no puede aprobarlo.</p> : !rejecting && (
          <form className="flex flex-wrap items-center gap-2" onSubmit={(e: FormEvent) => { e.preventDefault(); approve.mutate(); }}>
            {codeInput(`Código 2FA para aprobar ${r.asset_id}`, code, setCode)}
            <Button type="submit" size="sm" className="h-9" disabled={code.length !== 6 || approve.isPending}>{approve.isPending ? <Loader2 className="animate-spin" /> : <Check />}Aprobar</Button>
          </form>
        )}
        {rejecting ? (
          <form className="grid gap-2" onSubmit={(e: FormEvent) => { e.preventDefault(); reject.mutate(); }}>
            <Input aria-label="Motivo del rechazo" autoFocus maxLength={300} placeholder="Motivo (mín. 5 caracteres)" value={reason} onChange={(e) => setReason(e.target.value)} />
            <div className="flex gap-2">
              <Button type="button" size="sm" variant="outline" onClick={() => setRejecting(false)}>Volver</Button>
              <Button type="submit" size="sm" variant="destructive" disabled={reason.trim().length < 5 || reject.isPending}><X />Rechazar</Button>
            </div>
          </form>
        ) : <div><Button type="button" size="sm" variant="ghost" className="h-7 px-2 text-destructive" onClick={() => setRejecting(true)}><X />Rechazar…</Button></div>}
        <ErrorBox error={approve.error ?? reject.error} />
      </div>
    </div>
  );
}

export function HeldDepositsCard() {
  const { byId } = useAssets();
  const nets = useNetworks();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['held-deposits'], queryFn: () => api<{ deposits: DepositRow[] }>('/deposits?status=held&limit=100').then((r) => r.deposits), refetchInterval: 15_000 });
  const [codes, setCodes] = useState<Record<string, string>>({});
  const release = useMutation({
    mutationFn: (id: string) => api(`/deposits/${id}/release`, { method: 'POST', json: { code: codes[id] } }),
    onSuccess: () => REFRESH.forEach((k) => qc.invalidateQueries({ queryKey: [k] })),
  });
  if (!q.data?.length) return null;
  return (
    <Card data-section="held-deposits">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">Depósitos en revisión <Badge variant="warning">{q.data.length}</Badge></CardTitle>
        <CardDescription>Llegaron en un activo que el cliente no tiene habilitado para recibir. Acreditarlo no habilita el activo para depósitos futuros.</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-2">
        {q.data.map((d) => (
          <div key={d.id} data-held={d.id} className="flex flex-wrap items-center gap-3 rounded-md border p-3 text-sm">
            <Amount v={d.amount} asset={byId(d.asset_id)} exact className="font-semibold" />
            <Link to={`/clientes/${d.client_id}`} className="font-medium hover:underline">{d.client_name}</Link>
            <Badge variant="outline">{d.network ? nets.label(d.network) : '—'}</Badge>
            <a className="font-mono text-xs hover:underline" href={`${nets.explorer(d.network ?? '')}/tx/${d.tx_hash}`} target="_blank" rel="noreferrer noopener">{shortHex(d.tx_hash, 8)}</a>
            <span className="text-xs text-muted-foreground">{fmtDate(d.created_at)}</span>
            <form className="ml-auto flex items-center gap-2" onSubmit={(e: FormEvent) => { e.preventDefault(); release.mutate(d.id); }}>
              {codeInput(`Código 2FA para acreditar ${d.tx_hash}`, codes[d.id] ?? '', (v) => setCodes({ ...codes, [d.id]: v }))}
              <Button type="submit" size="sm" className="h-9" disabled={(codes[d.id] ?? '').length !== 6 || release.isPending}><Check />Acreditar</Button>
            </form>
          </div>
        ))}
        <ErrorBox error={release.error} />
      </CardContent>
    </Card>
  );
}
