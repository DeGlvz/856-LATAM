import { useState } from 'react';
import { Link } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { CheckCircle2, ShieldCheck } from 'lucide-react';
import { api, type Approvals as TApprovals } from '@/lib/api';
import { ago, shortHex } from '@/lib/amount';
import { useAuth } from '@/lib/auth';
import { useAssets } from '@/lib/hooks';
import { Amount, ErrorBox, fmtDate, StatusBadge } from '@/components/common';
import { ApprovalPanel } from '@/components/ApprovalPanel';
import { WithdrawalDialog } from '@/components/WithdrawalDialogs';
import { RunDialog } from '@/pages/Netting';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';

const POLICY = { off: 'desactivada', console: 'lo solicitado desde la consola', all: 'todo (consola y API)' } as const;

export function Approvals() {
  const { operator } = useAuth();
  const { byId } = useAssets();
  const q = useQuery({ queryKey: ['approvals'], queryFn: () => api<TApprovals>('/approvals'), refetchInterval: 15_000 });
  const explorer = useQuery({ queryKey: ['summary'], queryFn: () => api<{ explorer: string | null }>('/summary'), staleTime: 60_000 }).data?.explorer ?? 'https://sepolia.etherscan.io';
  const [wdId, setWdId] = useState<string | null>(null);
  const [runId, setRunId] = useState<string | null>(null);
  const d = q.data;
  const empty = d && !d.withdrawals.length && !d.netting_runs.length;

  return (
    <div className="mx-auto grid max-w-5xl grid-cols-[minmax(0,1fr)] gap-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Aprobaciones</h1>
        <p className="text-sm text-muted-foreground">
          Doble aprobación: quien solicita no aprueba{d?.policy.require_2fa ? ', y cada aprobación se confirma con código 2FA' : ''}.
          {d && <> Aplica a: <b>{POLICY[d.policy.dual_approval]}</b>.</>}
        </p>
      </div>
      {operator && !operator.totp_enabled && d?.policy.require_2fa && (
        <div className="flex items-center gap-2 rounded-md border px-3 py-2 text-sm">
          <ShieldCheck className="size-4" />Para aprobar necesita el 2FA activo. <Link to="/seguridad" className="font-medium underline">Ir a Seguridad</Link>
        </div>
      )}
      <ErrorBox error={q.error} />
      {q.isPending && <Skeleton className="h-40" />}
      {empty && (
        <Card><CardContent className="flex flex-col items-center gap-2 py-10 text-sm text-muted-foreground">
          <CheckCircle2 className="size-6 text-success" />Nada pendiente de aprobación.
        </CardContent></Card>
      )}

      {!!d?.withdrawals.length && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">Retiros <Badge variant="warning">{d.withdrawals.length}</Badge></CardTitle>
            <CardDescription>El saldo ya está reservado; el worker no firma hasta la aprobación. Rechazar devuelve el saldo al cliente.</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-3">
            {d.withdrawals.map((w) => (
              <div key={w.id} className="grid gap-3 rounded-lg border p-3 md:grid-cols-[minmax(0,1fr)_minmax(0,22rem)]">
                <div className="grid gap-1 text-sm">
                  <div className="flex flex-wrap items-center gap-2">
                    <Amount v={w.amount} asset={byId(w.asset_id)} exact className="text-base font-semibold" />
                    <Link to={`/clientes/${w.client_id}`} className="font-medium hover:underline">{w.client_name}</Link>
                    {w.client_status !== 'active' && <StatusBadge status={w.client_status} />}
                  </div>
                  <div className="font-mono text-xs text-muted-foreground" title={w.to_address}>→ {shortHex(w.to_address, 10)}</div>
                  <div className="text-xs text-muted-foreground">Solicitó {w.requested_by ?? '—'} · hace {ago(w.created_at)} ({fmtDate(w.created_at)})</div>
                  <div><button type="button" className="text-xs underline" onClick={() => setWdId(w.id)}>Ver detalle</button></div>
                </div>
                <ApprovalPanel kind="withdrawal" id={w.id} requestedByOperator={w.requested_by_operator} requestedBy={w.requested_by} compact />
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      {!!d?.netting_runs.length && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">Corridas de compensación <Badge variant="warning">{d.netting_runs.length}</Badge></CardTitle>
            <CardDescription>Al aprobar se liquidan exactamente las obligaciones solicitadas; si algo cambió, se rechaza sin mover saldo.</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-3">
            {d.netting_runs.map((r) => {
              const a = byId(r.asset_id);
              return (
                <div key={r.id} className="grid gap-3 rounded-lg border p-3 md:grid-cols-[minmax(0,1fr)_minmax(0,22rem)]">
                  <div className="grid gap-1 text-sm">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-muted-foreground">Neto</span><Amount v={r.net_amount} asset={a} exact className="text-base font-semibold" />
                      <span className="text-muted-foreground">de</span><Amount v={r.gross_amount} asset={a} />
                    </div>
                    <div className="text-xs text-muted-foreground">{r.obligations} obligaciones · {r.participants} participantes · ahorro {(r.savings_bps / 100).toFixed(2)} %</div>
                    <div className="text-xs text-muted-foreground">Corrida <span className="font-mono">{r.id.slice(0, 8)}</span> · solicitó {r.created_by ?? '—'} · hace {ago(r.created_at)}</div>
                    {r.last_error && <div className="text-xs text-destructive">Último intento: {r.last_error}</div>}
                    <div><button type="button" className="text-xs underline" onClick={() => setRunId(r.id)}>Ver detalle y simulación vigente</button></div>
                  </div>
                  <ApprovalPanel kind="run" id={r.id} requestedByOperator={r.requested_by_operator} requestedBy={r.created_by} compact />
                </div>
              );
            })}
          </CardContent>
        </Card>
      )}

      <WithdrawalDialog id={wdId} explorer={explorer} onClose={() => setWdId(null)} />
      <RunDialog id={runId} onClose={() => setRunId(null)} />
    </div>
  );
}
