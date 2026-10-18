import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, ArrowLeft, Check, ExternalLink, Loader2, Search, Send, Zap } from 'lucide-react';
import {
  api, newIdemKey, type ClientDetail, type ClientRow, type Wallet, type WithdrawalDetail, type WithdrawalStatus,
} from '@/lib/api';
import { ago, exactUnits, parseUnits, shortHex, toBig } from '@/lib/amount';
import { useAuth } from '@/lib/auth';
import { useAssets } from '@/lib/hooks';
import { Amount, CopyButton, ErrorBox, Field, fmtDate } from '@/components/common';
import { EntryDialog } from '@/components/EntryDialog';
import { ApprovalPanel } from '@/components/ApprovalPanel';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';

export const WD_STATUS: Record<WithdrawalStatus, { label: string; variant: 'secondary' | 'warning' | 'default' | 'success' | 'destructive' | 'outline' }> = {
  reserved: { label: 'Reservado', variant: 'secondary' },
  signed: { label: 'Firmado', variant: 'warning' },
  broadcast: { label: 'Enviado', variant: 'default' },
  confirmed: { label: 'Confirmado', variant: 'success' },
  failed: { label: 'Fallido', variant: 'destructive' },
  cancelled: { label: 'Cancelado', variant: 'outline' },
};

const STEPS: WithdrawalStatus[] = ['reserved', 'signed', 'broadcast', 'confirmed'];

/** Estado visible: un retiro reservado que espera autorización se muestra como «Por aprobar». */
export function WdBadge({ w }: { w: { status: WithdrawalStatus; approval_status?: string } }) {
  if (w.status === 'reserved' && w.approval_status === 'pending') return <Badge variant="warning">Por aprobar</Badge>;
  if (w.status === 'cancelled' && w.approval_status === 'rejected') return <Badge variant="outline">Rechazado</Badge>;
  return <Badge variant={WD_STATUS[w.status].variant}>{WD_STATUS[w.status].label}</Badge>;
}

// ───────────── Gas bump manual ─────────────
function BumpPanel({ id, since, bumps }: { id: string; since: string; bumps: number }) {
  const qc = useQueryClient();
  const m = useMutation({
    mutationFn: () => api<{ tx_hash: string; max_fee_per_gas: string; previous_max_fee_per_gas: string }>(`/withdrawals/${id}/bump`, { method: 'POST', json: {} }),
    onSuccess: () => ['withdrawal', 'withdrawals', 'summary'].forEach((k) => qc.invalidateQueries({ queryKey: [k] })),
  });
  return (
    <div className="grid gap-2 rounded-md border p-3 text-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p>Enviado hace {ago(since)} y aún sin minarse{bumps ? ` · acelerado ${bumps} ${bumps === 1 ? 'vez' : 'veces'}` : ''}. El worker lo acelera solo; puede forzarlo ahora.</p>
        <Button size="sm" variant="outline" onClick={() => m.mutate()} disabled={m.isPending}>{m.isPending ? <Loader2 className="animate-spin" /> : <Zap />}Acelerar (subir gas)</Button>
      </div>
      {m.data && <p className="text-xs text-success">Reemplazo enviado: comisión máx. {(Number(m.data.previous_max_fee_per_gas) / 1e9).toFixed(2)} → {(Number(m.data.max_fee_per_gas) / 1e9).toFixed(2)} gwei.</p>}
      <ErrorBox error={m.error} />
    </div>
  );
}

// ───────────── Detalle de un retiro ─────────────
export function WithdrawalDialog({ id, explorer, onClose }: { id: string | null; explorer: string; onClose: () => void }) {
  const { can } = useAuth();
  const { byId } = useAssets();
  const qc = useQueryClient();
  const [entryId, setEntryId] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const q = useQuery({
    queryKey: ['withdrawal', id], queryFn: () => api<WithdrawalDetail>(`/withdrawals/${id}`), enabled: !!id,
    refetchInterval: (query) => (['reserved', 'signed', 'broadcast'].includes(query.state.data?.status ?? '') ? 10_000 : false),
  });
  const cancel = useMutation({
    mutationFn: () => api<WithdrawalDetail>(`/withdrawals/${id}/cancel`, { method: 'POST', json: reason.trim() ? { reason: reason.trim() } : {} }),
    onSuccess: (w) => { qc.setQueryData(['withdrawal', id], w); ['withdrawals', 'summary', 'client', 'entries'].forEach((k) => qc.invalidateQueries({ queryKey: [k] })); },
  });
  useEffect(() => { if (id) { setReason(''); cancel.reset(); } }, [id]); // eslint-disable-line react-hooks/exhaustive-deps
  const w = q.data;
  const a = w ? byId(w.asset_id) : null;
  const native = w ? byId('ETH-SEPOLIA') : null;
  const stepIdx = w ? STEPS.indexOf(w.status) : -1;

  return (
    <>
      <Dialog open={!!id && !entryId} onOpenChange={(v) => !v && onClose()}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">Retiro {w && <WdBadge w={w} />}</DialogTitle>
            <DialogDescription className="flex items-center gap-1 font-mono text-xs">{id}{id && <CopyButton value={id} />}</DialogDescription>
          </DialogHeader>
          <ErrorBox error={q.error} />
          {q.isPending && id && <Skeleton className="h-48" />}
          {w && a && (
            <div className="grid gap-4">
              {/* Línea de tiempo */}
              {w.status === 'failed' || w.status === 'cancelled' ? (
                <div className={cn('rounded-md px-3 py-2 text-sm', w.status === 'failed' ? 'bg-destructive/10 text-destructive' : 'bg-muted')}>
                  {w.status === 'failed' ? 'Falló: el saldo reservado se devolvió al cliente.'
                    : w.approval_status === 'rejected' ? `Rechazado por ${w.rejected_by}: «${w.rejected_reason}». El saldo reservado se devolvió al cliente.`
                    : 'Cancelado: el saldo reservado se devolvió al cliente.'}
                </div>
              ) : (
                <ol className="grid grid-cols-4 gap-2">
                  {STEPS.map((s, i) => (
                    <li key={s} className="grid gap-1">
                      <div className={cn('h-1.5 rounded-full', i <= stepIdx ? (s === 'confirmed' ? 'bg-success' : 'bg-primary') : 'bg-muted')} />
                      <span className={cn('flex items-center gap-1 text-xs', i <= stepIdx ? 'text-foreground' : 'text-muted-foreground')}>
                        {i < stepIdx || w.status === 'confirmed' ? <Check className="size-3" /> : null}{WD_STATUS[s].label}
                      </span>
                    </li>
                  ))}
                </ol>
              )}

              <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-sm">
                <dt className="text-muted-foreground">Cliente</dt>
                <dd><Link to={`/clientes/${w.client_id}`} onClick={onClose} className="hover:underline">{w.client_name}</Link></dd>
                <dt className="text-muted-foreground">Monto</dt>
                <dd><Amount v={w.amount} asset={a} exact /></dd>
                <dt className="text-muted-foreground">Destino</dt>
                <dd className="flex items-center gap-1 font-mono text-xs break-all">
                  <a href={`${explorer}/address/${w.to_address}`} target="_blank" rel="noreferrer noopener" className="hover:underline">{w.to_address}</a><CopyButton value={w.to_address} />
                </dd>
                <dt className="text-muted-foreground">Transacción</dt>
                <dd className="font-mono text-xs break-all">
                  {w.tx_hash ? <a href={`${explorer}/tx/${w.tx_hash}`} target="_blank" rel="noreferrer noopener" className="inline-flex items-center gap-1 hover:underline">{w.tx_hash}<ExternalLink className="size-3" /></a> : '—'}
                </dd>
                <dt className="text-muted-foreground">Confirmaciones</dt>
                <dd className="num">{w.confirmations} / {w.required_confirmations}{w.block_number && <span className="text-muted-foreground"> · bloque {w.block_number}</span>}</dd>
                {w.nonce != null && <><dt className="text-muted-foreground">Nonce</dt><dd className="num">{w.nonce} <span className="text-muted-foreground">· intentos {w.attempts}</span></dd></>}
                {w.gas_cost_wei && native && <><dt className="text-muted-foreground">Gas pagado</dt><dd><Amount v={w.gas_cost_wei} asset={native} exact /></dd></>}
                <dt className="text-muted-foreground">Creado</dt><dd>{fmtDate(w.created_at)} <span className="text-muted-foreground">· actualizado {fmtDate(w.updated_at)}</span></dd>
                {w.requested_by && <><dt className="text-muted-foreground">Solicitó</dt><dd>{w.requested_by}</dd></>}
                {w.approved_by && <><dt className="text-muted-foreground">Aprobó</dt><dd>{w.approved_by}{w.approved_at && <span className="text-muted-foreground"> · {fmtDate(w.approved_at)}</span>}</dd></>}
                {w.last_error && <><dt className="text-muted-foreground">Último error</dt><dd className="text-destructive">{w.last_error}</dd></>}
              </dl>

              <div className="flex flex-wrap gap-2">
                {([['Reserva', w.reserve_entry_id], ['Liquidación', w.settle_entry_id], ['Reverso', w.reversal_entry_id]] as const)
                  .filter(([, e]) => e).map(([l, e]) => <Button key={l} size="sm" variant="outline" onClick={() => setEntryId(e)}>Asiento de {l.toLowerCase()}</Button>)}
              </div>

              {w.attempts_log?.length > 1 && (
                <div className="grid gap-1 text-xs">
                  <div className="font-medium">Envíos de la transacción (mismo nonce; solo uno se mina)</div>
                  {w.attempts_log.map((t) => (
                    <div key={t.tx_hash} className="flex flex-wrap items-center gap-2">
                      <Badge variant="outline">{t.reason === 'original' ? 'Original' : t.reason === 'manual' ? 'Acelerado (manual)' : 'Acelerado (auto)'}</Badge>
                      <a className={cn('font-mono hover:underline', t.tx_hash === w.tx_hash && 'font-semibold')} href={`${explorer}/tx/${t.tx_hash}`} target="_blank" rel="noreferrer noopener">{shortHex(t.tx_hash, 8)}</a>
                      <span className="text-muted-foreground">máx. {(Number(t.max_fee_per_gas) / 1e9).toFixed(2)} gwei{t.requested_by ? ` · ${t.requested_by}` : ''} · {fmtDate(t.created_at)}</span>
                      {t.error && <span className="text-destructive">{t.error}</span>}
                    </div>
                  ))}
                </div>
              )}

              {w.status === 'broadcast' && can('tesorero') && <BumpPanel id={w.id} since={w.broadcast_at ?? w.updated_at} bumps={w.bumps} />}

              {w.status === 'reserved' && w.approval_status === 'pending' && (
                <ApprovalPanel kind="withdrawal" id={w.id} requestedByOperator={w.requested_by_operator} requestedBy={w.requested_by} />
              )}

              {w.status === 'reserved' && w.approval_status !== 'pending' && can('ejecutivo') && (
                <div className="grid gap-2 rounded-md border border-destructive/30 p-3">
                  <p className="text-sm">Aún no se firma: puede cancelarse y el saldo vuelve al cliente.</p>
                  <div className="flex gap-2">
                    <Input aria-label="Motivo de cancelación" placeholder="Motivo (opcional)" maxLength={300} value={reason} onChange={(e) => setReason(e.target.value)} />
                    <Button variant="destructive" disabled={cancel.isPending} onClick={() => cancel.mutate()}>{cancel.isPending && <Loader2 className="animate-spin" />}Cancelar retiro</Button>
                  </div>
                  <ErrorBox error={cancel.error} />
                </div>
              )}
            </div>
          )}
        </DialogContent>
      </Dialog>
      <EntryDialog id={entryId} onClose={() => setEntryId(null)} />
    </>
  );
}

// ───────────── Nueva instrucción de retiro ─────────────
export function NewWithdrawalDialog({ open, onOpenChange, presetClientId, onCreated }: {
  open: boolean; onOpenChange: (v: boolean) => void; presetClientId?: string | null; onCreated: (id: string) => void;
}) {
  const qc = useQueryClient();
  const { byId } = useAssets();
  const [clientId, setClientId] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [assetId, setAssetId] = useState('');
  const [dest, setDest] = useState('');
  const [amountText, setAmountText] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [key, setKey] = useState(newIdemKey);

  useEffect(() => {
    if (open) { setClientId(presetClientId ?? null); setSearch(''); setAssetId(''); setDest(''); setAmountText(''); setConfirming(false); setKey(newIdemKey()); }
  }, [open, presetClientId]);

  const found = useQuery({
    queryKey: ['clients', { q: search, status: 'active', picker: true }],
    queryFn: () => api<{ clients: ClientRow[] }>(`/clients?status=active&limit=8${search.trim() ? `&q=${encodeURIComponent(search.trim())}` : ''}`).then((r) => r.clients),
    enabled: open && !clientId,
  });
  const client = useQuery({ queryKey: ['client', clientId], queryFn: () => api<ClientDetail>(`/clients/${clientId}`), enabled: open && !!clientId });
  const wallets = useQuery({
    queryKey: ['wallets', clientId], queryFn: () => api<{ wallets: Wallet[] }>(`/wallets?client_id=${clientId}`).then((r) => r.wallets), enabled: open && !!clientId,
  });

  const accounts = (client.data?.accounts ?? []).filter((a) => toBig(a.balance)! > 0n);
  const whitelist = (wallets.data ?? []).filter((w) => w.purpose === 'withdrawal_whitelist' && w.active);
  useEffect(() => { if (!assetId && accounts[0]) setAssetId(accounts[0].asset_id); }, [accounts, assetId]);
  useEffect(() => { if (!dest && whitelist[0]) setDest(whitelist[0].address); }, [whitelist, dest]);

  const asset = byId(assetId);
  const account = accounts.find((a) => a.asset_id === assetId);
  const base = useMemo(() => (assetId ? parseUnits(amountText, asset.decimals) : null), [amountText, assetId, asset.decimals]);
  const over = base != null && account ? BigInt(base) > BigInt(account.balance) : false;
  const notActive = client.data && client.data.status !== 'active';
  const ready = !!clientId && !!account && !!dest && base != null && !over && !notActive;

  const m = useMutation({
    mutationFn: () => api<WithdrawalDetail>('/withdrawals', {
      method: 'POST', headers: { 'idempotency-key': key }, json: { client_id: clientId, asset_id: assetId, to_address: dest, amount: base },
    }),
    onSuccess: (w) => { ['withdrawals', 'summary', 'client', 'entries'].forEach((k) => qc.invalidateQueries({ queryKey: [k] })); onOpenChange(false); onCreated(w.id); },
  });

  const submit = (e: FormEvent) => { e.preventDefault(); if (!confirming) setConfirming(true); else m.mutate(); };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Nuevo retiro on-chain</DialogTitle>
          <DialogDescription>Por instrucción interna, el saldo se reserva y el retiro pasa directamente al worker. Solo clientes activos y destinos en su lista blanca.</DialogDescription>
        </DialogHeader>

        {!clientId ? (
          <div className="grid gap-2">
            <div className="relative">
              <Search className="pointer-events-none absolute top-2.5 left-2.5 size-4 text-muted-foreground" />
              <Input autoFocus aria-label="Buscar cliente activo" className="pl-8" placeholder="Buscar cliente activo" value={search} onChange={(e) => setSearch(e.target.value)} />
            </div>
            <div className="grid max-h-64 gap-1 overflow-y-auto">
              {found.isPending && <Skeleton className="h-10" />}
              {found.data?.length === 0 && <p className="py-4 text-center text-sm text-muted-foreground">Sin clientes activos con ese criterio</p>}
              {found.data?.map((c) => (
                <button key={c.id} type="button" onClick={() => setClientId(c.id)} className="flex items-center justify-between rounded-md border px-3 py-2 text-left text-sm hover:bg-accent">
                  <span className="font-medium">{c.name}</span><span className="font-mono text-[11px] text-muted-foreground">{c.id.slice(0, 8)}</span>
                </button>
              ))}
            </div>
          </div>
        ) : (
          <form onSubmit={submit} className="grid gap-4">
            <div className="flex items-center justify-between rounded-md bg-muted px-3 py-2 text-sm">
              <span><span className="text-muted-foreground">Cliente:</span> <b>{client.data?.name ?? '…'}</b></span>
              {!presetClientId && !confirming && <Button type="button" variant="ghost" size="sm" className="h-7" onClick={() => { setClientId(null); setAssetId(''); setDest(''); }}>Cambiar</Button>}
            </div>
            {notActive && <ErrorBox error={`Cliente en estado «${client.data?.status}»: solo clientes activos pueden retirar.`} />}

            {confirming ? (
              <div className="grid gap-3 rounded-md border border-warning/60 bg-warning/10 p-4 text-sm">
                <div className="flex items-center gap-2 font-medium"><AlertTriangle className="size-4" />Confirme el retiro: una vez firmado no se puede revertir.</div>
                <p>Este retiro se registra como instrucción interna y el worker lo ejecutará después de validar saldo, estado del cliente y lista blanca.</p>
                <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
                  <dt className="text-muted-foreground">Monto</dt><dd className="font-mono">{exactUnits(base, asset.decimals)} {asset.symbol}</dd>
                  <dt className="text-muted-foreground">Unidades base</dt><dd className="font-mono text-xs">{base}</dd>
                  <dt className="text-muted-foreground">Destino</dt><dd className="font-mono text-xs break-all">{dest}</dd>
                  <dt className="text-muted-foreground">Red</dt><dd>{asset.network}</dd>
                </dl>
              </div>
            ) : (
              <>
                <div className="grid gap-4 sm:grid-cols-2">
                  <Field label="Activo" htmlFor="nw-asset" hint={account ? `Disponible: ${exactUnits(account.balance, asset.decimals)} ${asset.symbol}` : undefined}>
                    <Select id="nw-asset" value={assetId} onChange={(e) => setAssetId(e.target.value)} disabled={!accounts.length}>
                      {!accounts.length && <option value="">Sin saldo disponible</option>}
                      {accounts.map((a) => <option key={a.asset_id} value={a.asset_id}>{byId(a.asset_id).symbol} · {a.asset_id}</option>)}
                    </Select>
                  </Field>
                  <Field label={`Monto${assetId ? ` (${asset.symbol})` : ''}`} htmlFor="nw-amount" hint={`Hasta ${asset.decimals} decimales, punto decimal`}>
                    <div className="flex gap-2">
                      <Input id="nw-amount" inputMode="decimal" autoComplete="off" className="font-mono" value={amountText} onChange={(e) => setAmountText(e.target.value)}
                        aria-invalid={amountText !== '' && (base == null || over)} />
                      {account && <Button type="button" variant="outline" size="sm" className="h-9" onClick={() => setAmountText(exactUnits(account.balance, asset.decimals).replace(/,/g, ''))}>Máx.</Button>}
                    </div>
                  </Field>
                </div>
                {over && <p className="text-sm text-destructive">El monto excede el saldo disponible.</p>}
                <Field label="Destino (lista blanca)" htmlFor="nw-dest">
                  {whitelist.length ? (
                    <Select id="nw-dest" value={dest} onChange={(e) => setDest(e.target.value)} className="font-mono text-xs">
                      {whitelist.map((w) => <option key={w.id} value={w.address}>{shortHex(w.address, 10)}{w.label ? ` · ${w.label}` : ''}</option>)}
                    </Select>
                  ) : (
                    <p className="text-sm text-muted-foreground">El cliente no tiene direcciones activas en lista blanca. <Link className="underline" to={`/clientes/${clientId}`} onClick={() => onOpenChange(false)}>Agregar en su detalle</Link>.</p>
                  )}
                </Field>
              </>
            )}

            <ErrorBox error={m.error} />
            <DialogFooter>
              {confirming
                ? <Button type="button" variant="outline" onClick={() => setConfirming(false)}><ArrowLeft />Corregir</Button>
                : <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>Cancelar</Button>}
              <Button type="submit" disabled={!ready || m.isPending}>
                {m.isPending ? <Loader2 className="animate-spin" /> : <Send />}{confirming ? 'Confirmar retiro' : 'Revisar'}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
