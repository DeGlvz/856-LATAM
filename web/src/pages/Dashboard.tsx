import { useQuery } from '@tanstack/react-query';
import {
  Activity, AlertTriangle, CheckCircle2, Database, ExternalLink, Fuel, RefreshCw, Scale, Send, XCircle,
} from 'lucide-react';
import { api, type Asset, type InflightWithdrawal, type ReconBalance, type Summary } from '@/lib/api';
import { ago, exactUnits, formatUnits, shortHex, toBig } from '@/lib/amount';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { cn } from '@/lib/utils';

const REFRESH_MS = 15_000;

const WD_STATUS: Record<InflightWithdrawal['status'], { label: string; variant: 'secondary' | 'warning' | 'default' }> = {
  reserved: { label: 'Reservado', variant: 'secondary' },
  signed: { label: 'Firmado', variant: 'warning' },
  broadcast: { label: 'Enviado', variant: 'default' },
};

export function Dashboard() {
  const q = useQuery({ queryKey: ['summary'], queryFn: () => api<Summary>('/summary'), refetchInterval: REFRESH_MS });
  const s = q.data;

  return (
    <div className="mx-auto grid max-w-7xl grid-cols-[minmax(0,1fr)] gap-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Tablero</h1>
          <p className="text-sm text-muted-foreground">
            {s ? <>Red <span className="font-mono">{s.health.chain.network}</span> · actualizado {new Date(s.generated_at).toLocaleTimeString('es-MX')}</> : 'Cargando estado…'}
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={() => q.refetch()} disabled={q.isFetching}>
          <RefreshCw className={cn(q.isFetching && 'animate-spin')} />Actualizar
        </Button>
      </div>

      {q.isError && (
        <div role="alert" className="flex items-center gap-2 rounded-lg border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          <XCircle className="size-4" />No se pudo obtener el tablero: {(q.error as Error).message}
        </div>
      )}

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {s ? <>
          <HealthCard s={s} />
          <GasCard s={s} />
          <InflightCard s={s} />
          <ReconCard s={s} />
        </> : [0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-36 rounded-xl" />)}
      </div>

      {s ? <ReconTable s={s} /> : <Skeleton className="h-48 rounded-xl" />}
      {s ? <InflightTable s={s} /> : <Skeleton className="h-48 rounded-xl" />}

      {s && (
        <div className="flex flex-wrap gap-x-6 gap-y-1 text-xs text-muted-foreground">
          <span>Depósitos pendientes de confirmar: <b className="num text-foreground">{s.deposits_pending}</b></span>
          <span>Barridos abiertos: <b className="num text-foreground">{s.sweeps_open}</b></span>
          <span>Clientes: {Object.entries(s.clients_by_status).map(([k, v]) => `${k} ${v}`).join(' · ') || '0'}</span>
          <span>Confirmaciones requeridas: <b className="num text-foreground">{s.health.confirmations}</b></span>
        </div>
      )}
    </div>
  );
}

// ───────────── Tarjetas ─────────────
function Dot({ ok }: { ok: boolean | null }) {
  return <span className={cn('inline-block size-2 rounded-full', ok == null ? 'bg-muted-foreground/40' : ok ? 'bg-success' : 'bg-destructive')} />;
}

function HealthCard({ s }: { s: Summary }) {
  const h = s.health;
  const ok = h.status === 'ok';
  return (
    <Card className={cn(!ok && 'border-destructive/40')}>
      <CardHeader>
        <CardDescription className="flex items-center gap-1.5"><Activity className="size-4" />Salud</CardDescription>
        <CardTitle className={cn('text-2xl', ok ? 'text-success' : 'text-destructive')}>{ok ? 'Operando' : 'Degradado'}</CardTitle>
      </CardHeader>
      <CardContent className="grid gap-1.5 text-sm">
        <div className="flex items-center gap-2"><Dot ok={h.db === 'ok'} /><Database className="size-3.5 text-muted-foreground" />Base de datos <span className="ml-auto text-muted-foreground">{h.db}</span></div>
        <div className="flex items-center gap-2"><Dot ok={h.chain.status === 'ok'} />Cadena
          <span className="num ml-auto font-mono text-xs text-muted-foreground" title={h.chain.error ?? undefined}>
            {h.chain.status === 'ok' ? `#${h.chain.block}` : 'sin respuesta'}
          </span>
        </div>
        <div className="flex items-center gap-2"><Dot ok={h.worker_enabled} />Worker
          <span className="ml-auto text-xs text-muted-foreground">{h.worker_enabled ? 'activo' : 'apagado'}</span>
        </div>
        <div className="flex items-center gap-2"><Dot ok={!!h.signer} />Firmante
          <span className="ml-auto truncate font-mono text-xs text-muted-foreground">{h.signer ?? 'no configurado'}</span>
        </div>
      </CardContent>
    </Card>
  );
}

function GasCard({ s }: { s: Summary }) {
  const g = s.gas;
  const sym = s.assets.find((a) => a.id === g.asset_id)?.symbol ?? 'ETH';
  return (
    <Card className={cn(g.low && 'border-destructive/40 bg-destructive/5')}>
      <CardHeader>
        <CardDescription className="flex items-center gap-1.5"><Fuel className="size-4" />Gas (hot wallet)</CardDescription>
        <CardTitle className={cn('num text-2xl', g.low && 'text-destructive')} title={g.balance_wei ? `${exactUnits(g.balance_wei, g.decimals)} ${sym}` : undefined}>
          {g.balance_wei != null ? <>{formatUnits(g.balance_wei, g.decimals, 5)} <span className="text-base font-normal text-muted-foreground">{sym}</span></> : '—'}
        </CardTitle>
        {g.low != null && <CardAction>{g.low ? <Badge variant="destructive"><AlertTriangle />Bajo</Badge> : <Badge variant="success">Suficiente</Badge>}</CardAction>}
      </CardHeader>
      <CardContent className="grid gap-1 text-xs text-muted-foreground">
        <div>Umbral de alerta: <span className="num">{formatUnits(g.threshold_wei, g.decimals)} {sym}</span></div>
        <AddressLink explorer={s.explorer} address={g.address} />
      </CardContent>
    </Card>
  );
}

function InflightCard({ s }: { s: Summary }) {
  const w = s.withdrawals_in_flight;
  const errors = w.items.filter((i) => i.last_error).length;
  return (
    <Card className={cn(errors > 0 && 'border-warning/60')}>
      <CardHeader>
        <CardDescription className="flex items-center gap-1.5"><Send className="size-4" />Retiros en vuelo</CardDescription>
        <CardTitle className="num text-2xl">{w.total}</CardTitle>
        {errors > 0 && <CardAction><Badge variant="warning"><AlertTriangle />{errors} con error</Badge></CardAction>}
      </CardHeader>
      <CardContent className="flex flex-wrap gap-1.5">
        {(['reserved', 'signed', 'broadcast'] as const).map((k) => (
          <Badge key={k} variant="outline" className="num">{WD_STATUS[k].label}: {w.by_status[k] ?? 0}</Badge>
        ))}
      </CardContent>
    </Card>
  );
}

function ReconCard({ s }: { s: Summary }) {
  const r = s.reconciliation;
  const bad = r.balances.filter((b) => b.difference == null || toBig(b.difference) !== 0n);
  const ok = r.status === 'ok' && bad.length === 0;
  return (
    <Card className={cn(!ok && 'border-destructive/40 bg-destructive/5')}>
      <CardHeader>
        <CardDescription className="flex items-center gap-1.5"><Scale className="size-4" />Conciliación</CardDescription>
        <CardTitle className={cn('text-xl', ok ? 'text-success' : 'text-destructive')}>
          {r.status !== 'ok' ? 'Sin datos' : ok ? 'Cuadrada' : `${bad.length} con diferencia`}
        </CardTitle>
        <CardAction>{ok ? <CheckCircle2 className="size-5 text-success" /> : <AlertTriangle className="size-5 text-destructive" />}</CardAction>
      </CardHeader>
      <CardContent className="text-xs text-muted-foreground">
        {r.status === 'ok'
          ? <>{r.balances.length} activos · hot wallet + {r.deposit_addresses} direcciones de depósito</>
          : r.error}
      </CardContent>
    </Card>
  );
}

// ───────────── Tablas ─────────────
function ReconTable({ s }: { s: Summary }) {
  const r = s.reconciliation;
  const assetOf = (id: string): Asset => s.assets.find((a) => a.id === id) ?? { id, symbol: id, decimals: 0, kind: '', network: '' };
  return (
    <Card>
      <CardHeader>
        <CardTitle>Conciliación por activo</CardTitle>
        <CardDescription>Diferencia = on-chain (hot wallet + direcciones de depósito) − custodia en libro. Cualquier diferencia distinta de cero se marca en rojo.</CardDescription>
      </CardHeader>
      <CardContent>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Activo</TableHead>
              <TableHead className="text-right">Hot wallet</TableHead>
              <TableHead className="text-right">Depósitos</TableHead>
              <TableHead className="text-right">Total on-chain</TableHead>
              <TableHead className="text-right">Custodia en libro</TableHead>
              <TableHead className="text-right">Diferencia</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {r.balances.length === 0 && (
              <TableRow><TableCell colSpan={6} className="py-6 text-center text-muted-foreground">{r.error ?? 'Sin activos para conciliar'}</TableCell></TableRow>
            )}
            {r.balances.map((b) => <ReconRow key={b.asset_id} b={b} a={assetOf(b.asset_id)} />)}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}

function Amt({ v, a }: { v?: string | null; a: Asset }) {
  return <span className="num font-mono text-[13px]" title={v != null ? `${exactUnits(v, a.decimals)} ${a.symbol} (${v} unidades base)` : undefined}>{formatUnits(v, a.decimals)}</span>;
}

function ReconRow({ b, a }: { b: ReconBalance; a: Asset }) {
  const d = toBig(b.difference);
  const bad = d == null || d !== 0n;
  return (
    <TableRow className={cn(bad && 'bg-destructive/8 hover:bg-destructive/12')}>
      <TableCell>
        <div className="font-medium">{a.symbol}</div>
        <div className="font-mono text-[11px] text-muted-foreground">{b.asset_id}</div>
      </TableCell>
      <TableCell className="text-right"><Amt v={b.hot_wallet} a={a} /></TableCell>
      <TableCell className="text-right"><Amt v={b.deposit_addresses} a={a} /></TableCell>
      <TableCell className="text-right"><Amt v={b.onchain_total} a={a} /></TableCell>
      <TableCell className="text-right"><Amt v={b.ledger_custody} a={a} /></TableCell>
      <TableCell className={cn('text-right font-semibold', bad ? 'text-destructive' : 'text-success')}>
        {d == null ? <span className="text-xs font-normal">{b.error ?? 'sin dato'}</span>
          : <>{d > 0n ? '+' : ''}<Amt v={b.difference} a={a} /></>}
      </TableCell>
    </TableRow>
  );
}

function InflightTable({ s }: { s: Summary }) {
  const items = s.withdrawals_in_flight.items;
  const assetOf = (id: string): Asset => s.assets.find((a) => a.id === id) ?? { id, symbol: id, decimals: 0, kind: '', network: '' };
  return (
    <Card>
      <CardHeader>
        <CardTitle>Retiros en vuelo</CardTitle>
        <CardDescription>Reservados, firmados o enviados que aún no alcanzan {s.health.confirmations} confirmaciones (más antiguos primero).</CardDescription>
      </CardHeader>
      <CardContent>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Estado</TableHead>
              <TableHead>Cliente</TableHead>
              <TableHead className="text-right">Monto</TableHead>
              <TableHead>Destino</TableHead>
              <TableHead>Tx</TableHead>
              <TableHead className="text-right">Conf.</TableHead>
              <TableHead className="text-right">Antigüedad</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {items.length === 0 && (
              <TableRow><TableCell colSpan={7} className="py-6 text-center text-muted-foreground">No hay retiros en vuelo</TableCell></TableRow>
            )}
            {items.map((w) => {
              const a = assetOf(w.asset_id);
              return (
                <TableRow key={w.id} className={cn(w.last_error && 'bg-warning/10')}>
                  <TableCell>
                    <Badge variant={WD_STATUS[w.status].variant}>{WD_STATUS[w.status].label}</Badge>
                    {w.last_error && <div className="mt-1 max-w-56 truncate text-[11px] text-destructive" title={w.last_error}>{w.last_error}</div>}
                  </TableCell>
                  <TableCell>
                    <div className="max-w-48 truncate font-medium">{w.client_name}</div>
                    <div className="font-mono text-[11px] text-muted-foreground">{w.id.slice(0, 8)}</div>
                  </TableCell>
                  <TableCell className="text-right"><Amt v={w.amount} a={a} /> <span className="text-xs text-muted-foreground">{a.symbol}</span></TableCell>
                  <TableCell><AddressLink explorer={s.explorer} address={w.to_address} bare /></TableCell>
                  <TableCell>{w.tx_hash
                    ? <a className="inline-flex items-center gap-1 font-mono text-xs hover:underline" href={s.explorer ? `${s.explorer}/tx/${w.tx_hash}` : undefined} target="_blank" rel="noreferrer noopener">{shortHex(w.tx_hash)}<ExternalLink className="size-3" /></a>
                    : <span className="text-xs text-muted-foreground">—</span>}
                    {w.attempts > 0 && <div className="text-[11px] text-muted-foreground">intentos {w.attempts}{w.nonce != null && ` · nonce ${w.nonce}`}</div>}
                  </TableCell>
                  <TableCell className="num text-right">{w.confirmations}/{s.health.confirmations}</TableCell>
                  <TableCell className="num text-right text-muted-foreground" title={new Date(w.created_at).toLocaleString('es-MX')}>{ago(w.created_at)}</TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}

function AddressLink({ explorer, address, bare }: { explorer: string | null; address: string | null; bare?: boolean }) {
  if (!address) return <span>{bare ? '—' : 'Sin firmante configurado'}</span>;
  const text = shortHex(address);
  return (
    <a className="inline-flex items-center gap-1 font-mono text-xs hover:underline" title={address}
      href={explorer ? `${explorer}/address/${address}` : undefined} target="_blank" rel="noreferrer noopener">
      {!bare && 'Dirección '}{text}<ExternalLink className="size-3" />
    </a>
  );
}
