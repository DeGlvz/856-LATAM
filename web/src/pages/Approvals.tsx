import { useState } from 'react';
import { Link } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { CheckCircle2, Clock, ShieldCheck } from 'lucide-react';
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
import { cn } from '@/lib/utils';
import { AssetRequestsCard, HeldDepositsCard } from '@/components/AssetApprovals';

const POLICY = { off: 'desactivada', console: 'lo solicitado desde la consola', all: 'todo (consola y API)' } as const;

export function Approvals() {
  const { operator, can } = useAuth();
  const { byId } = useAssets();
  const q = useQuery({ queryKey: ['approvals'], queryFn: () => api<TApprovals>('/approvals'), refetchInterval: 15_000 });
  const explorer = useQuery({ queryKey: ['summary'], queryFn: () => api<{ explorer: string | null }>('/summary'), staleTime: 60_000 }).data?.explorer ?? 'https://sepolia.etherscan.io';
  const [wdId, setWdId] = useState<string | null>(null);
  const [runId, setRunId] = useState<string | null>(null);
  const d = q.data;
  const empty = d && !d.withdrawals.length && !d.netting_runs.length;
  const exits = d?.withdrawals.filter((w) => w.simulation_id) ?? [];
  const legacy = d?.withdrawals.filter((w) => !w.simulation_id) ?? [];

  return (
    <div className="mx-auto grid max-w-5xl grid-cols-[minmax(0,1fr)] gap-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Aprobaciones</h1>
        <p className="text-sm text-muted-foreground">
          Los retiros de clientes requieren una autorización individual de un ejecutivo de cuenta o tesorero distinto{d?.policy.require_2fa ? ', confirmada con código 2FA' : ''}.
          {d && <> Para corridas de compensación aplica: <b>{POLICY[d.policy.dual_approval]}</b>.</>}
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

      {!!exits.length && (
        <Card data-section="exits">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">Salidas por validar <Badge variant="warning">{exits.length}</Badge></CardTitle>
            <CardDescription>Las originó el cliente con una simulación. Se autoriza exactamente lo simulado (huella); si cambió el destino o sus obligaciones, se rechaza con «simular de nuevo». La consola no origina salidas.</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-3">
            {exits.map((w) => {
              const a = byId(w.asset_id);
              return (
                <div key={w.id} data-exit={w.id} className={cn('grid gap-3 rounded-lg border p-3 md:grid-cols-[minmax(0,1fr)_minmax(0,22rem)]', w.overdue && 'border-warning')}>
                  <div className="grid gap-1 text-sm">
                    <div className="flex flex-wrap items-center gap-2">
                      <Amount v={w.amount} asset={a} exact className="text-base font-semibold" />
                      <Link to={`/clientes/${w.client_id}`} className="font-medium hover:underline">{w.client_name}</Link>
                      {w.client_status !== 'active' && <StatusBadge status={w.client_status} />}
                      {w.overdue && <Badge variant="warning"><Clock />Vencida</Badge>}
                    </div>
                    <div className="font-mono text-xs text-muted-foreground" title={w.to_address}>→ {w.to_address}{w.wl_label && <span className="font-sans"> · {w.wl_label}</span>}</div>
                    <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 text-xs">
                      <dt className="text-muted-foreground">Originó</dt><dd>{w.origin_label ?? '—'} · hace {ago(w.created_at)}</dd>
                      {w.client_approver && <><dt className="text-muted-foreground">Aprobó cliente</dt><dd>{w.client_approver}{w.client_approved_at && ` · ${fmtDate(w.client_approved_at)}`}</dd></>}
                      {w.sim_available && <><dt className="text-muted-foreground">Simulación</dt><dd>disponible <Amount v={w.sim_available} asset={a} /> → queda <Amount v={w.sim_balance_after} asset={a} />{w.sim_fee && BigInt(w.sim_fee) > 0n && <> · comisión <Amount v={w.sim_fee} asset={a} /></>}</dd></>}
                      {w.sim_payable_open && BigInt(w.sim_payable_open) > 0n && <><dt className="text-muted-foreground">Por pagar</dt><dd>obligaciones abiertas <Amount v={w.sim_payable_open} asset={a} /></dd></>}
                      <dt className="text-muted-foreground">Huella</dt><dd className="font-mono" title={w.scope_hash ?? ''}>{shortHex(w.scope_hash, 10)}</dd>
                      {w.validation_due_at && <><dt className="text-muted-foreground">Responder antes de</dt><dd>{fmtDate(w.validation_due_at)}</dd></>}
                    </dl>
                    <div><button type="button" className="text-xs underline" onClick={() => setWdId(w.id)}>Ver detalle</button></div>
                  </div>
                  <ApprovalPanel kind="withdrawal" id={w.id} requestedByOperator={null} requestedBy={w.origin_label} compact exit
                  />
                </div>
              );
            })}
          </CardContent>
        </Card>
      )}

      {!!legacy.length && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">Retiros <Badge variant="warning">{legacy.length}</Badge></CardTitle>
            <CardDescription>El saldo ya está reservado; el worker no firma hasta la aprobación. Rechazar devuelve el saldo al cliente.</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-3">
            {legacy.map((w) => (
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
                <ApprovalPanel kind="withdrawal" id={w.id} requestedByOperator={w.requested_by_operator} requestedBy={w.requested_by} compact
                />
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

      {can('tesorero') && <AssetRequestsCard />}
      {can('tesorero') && <HeldDepositsCard />}

      <WithdrawalDialog id={wdId} explorer={explorer} onClose={() => setWdId(null)} />
      <RunDialog id={runId} onClose={() => setRunId(null)} />
    </div>
  );
}
