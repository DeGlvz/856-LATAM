import { useEffect, useState, type FormEvent } from 'react';
import { Link, useParams } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, ArrowLeft, ArrowLeftRight, Eye, ExternalLink, KeyRound, Loader2, Pencil, Plus, RefreshCw, Scale, ShieldCheck, UserPlus, Users, Wallet as WalletIcon } from 'lucide-react';
import { api, type ClientDetail as TClient, type ClientStatus, type EntryRow, type ObligationRow, type Summary, type Wallet } from '@/lib/api';
import { launchAssistTab, openAssistTab } from '@/lib/assist';
import { useAuth } from '@/lib/auth';
import { CLIENT_KIND, CLIENT_STATUS, ENTRY_KIND, useAssets, useConsoleOriginates, useNetworks } from '@/lib/hooks';
import { ClientAssetsCard } from '@/components/ClientAssets';
import { shortHex } from '@/lib/amount';
import { Amount, CopyButton, ErrorBox, Field, StatusBadge, fmtDate } from '@/components/common';
import { EntryDialog } from '@/components/EntryDialog';
import { ObligationDialog, ObligationsTable } from '@/components/ObligationDialogs';
import { RunDialog } from '@/pages/Netting';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Textarea } from '@/components/ui/textarea';

export function ClientDetail() {
  const { id = '' } = useParams();
  const { can } = useAuth();
  const { byId, assets } = useAssets();
  const qc = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [changingStatus, setChangingStatus] = useState(false);
  const [entryId, setEntryId] = useState<string | null>(null);
  const [obligation, setObligation] = useState<ObligationRow | null>(null);
  const [obStatus, setObStatus] = useState<'open' | 'all'>('open');
  const [runId, setRunId] = useState<string | null>(null);
  const [assistPopupError, setAssistPopupError] = useState('');
  const assist = useMutation({
    mutationFn: ({ tab }: { tab: Window }) => launchAssistTab(id, 'client_detail', tab),
  });

  const client = useQuery({ queryKey: ['client', id], queryFn: () => api<TClient>(`/clients/${id}`) });
  const wallets = useQuery({ queryKey: ['wallets', id], queryFn: () => api<{ wallets: Wallet[] }>(`/wallets?client_id=${id}`).then((r) => r.wallets) });
  const entries = useQuery({ queryKey: ['entries', { client_id: id }], queryFn: () => api<{ entries: EntryRow[] }>(`/entries?client_id=${id}&limit=20&postings=false`).then((r) => r.entries) });
  // Red y explorador vienen del tablero (misma fuente que el API)
  const summary = useQuery({ queryKey: ['summary'], queryFn: () => api<Summary>('/summary'), staleTime: 60_000 });
  const explorer = summary.data?.explorer ?? 'https://sepolia.etherscan.io';
  const network = summary.data?.health.chain.network ?? 'eth-sepolia';
  const refresh = () => { ['client', 'wallets', 'entries', 'clients'].forEach((k) => qc.invalidateQueries({ queryKey: [k] })); };

  const openAccount = useMutation({
    mutationFn: (asset_id: string) => api(`/clients/${id}/accounts`, { method: 'POST', json: { asset_id } }),
    onSuccess: refresh,
  });
  const nets = useNetworks();
  const [depNet, setDepNet] = useState('');
  const depositAddr = useMutation({
    mutationFn: (rotate: boolean) => api(`/clients/${id}/deposit-address`, { method: 'POST', json: { rotate, ...(depNet ? { network: depNet } : {}) } }),
    onSuccess: refresh,
  });

  if (client.isPending) return <div className="mx-auto grid max-w-7xl gap-4"><Skeleton className="h-24" /><Skeleton className="h-48" /></div>;
  if (client.error || !client.data) return <div className="mx-auto max-w-7xl"><BackLink /><ErrorBox error={client.error ?? 'No encontrado'} className="mt-4" /></div>;
  const c = client.data;
  const closed = c.status === 'closed';
  const missing = assets.filter((a) => a.active && !c.accounts.some((x) => x.asset_id === a.id));
  const deposits = (wallets.data ?? []).filter((w) => w.purpose === 'deposit');
  const whitelist = (wallets.data ?? []).filter((w) => w.purpose === 'withdrawal_whitelist');
  const selNet = depNet || network;
  const current = deposits.find((w) => w.active && w.derivation_index != null && w.network === selNet);

  return (
    <div className="mx-auto grid max-w-7xl grid-cols-[minmax(0,1fr)] gap-6">
      <BackLink />
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="truncate text-xl font-semibold tracking-tight">{c.name}</h1>
            <StatusBadge status={c.status} />
            <Badge variant="outline">{CLIENT_KIND[c.kind]}</Badge>
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
            <span className="inline-flex items-center gap-1 font-mono">{c.id}<CopyButton value={c.id} /></span>
            {c.external_id && <span>Id externo: <span className="font-mono">{c.external_id}</span></span>}
            <span>Alta: {fmtDate(c.created_at)}</span>
          </div>
          {c.status_reason && (
            <p className="mt-2 text-sm"><span className="text-muted-foreground">Motivo del estado{c.status_changed_at && ` (${fmtDate(c.status_changed_at)})`}:</span> {c.status_reason}</p>
          )}
        </div>
        <div className="flex flex-wrap gap-2">
          <Button asChild variant="outline" size="sm"><Link to={`/movimientos?client_id=${c.id}`}><ArrowLeftRight />Retiros y depósitos</Link></Button>
          {can('ejecutivo') && <Button variant="outline" size="sm" disabled={assist.isPending} onClick={() => {
            const tab = openAssistTab();
            if (tab) {
              setAssistPopupError('');
              assist.mutate({ tab });
            } else {
              setAssistPopupError('Permita las ventanas emergentes para abrir el portal en otra pestaña.');
            }
          }}><Eye />Ver como cliente</Button>}
        {can('ejecutivo') && !closed && (
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={() => setEditing(true)}><Pencil />Editar</Button>
            <Button variant="outline" size="sm" onClick={() => setChangingStatus(true)} disabled={!c.allowed_transitions.length}><ShieldCheck />Cambiar estado</Button>
          </div>
        )}
        </div>
      </div>
      <ErrorBox error={assist.error ?? assistPopupError} />

      {c.status === 'pending_kyb' && (
        <div className="rounded-lg border border-warning/50 bg-warning/10 px-4 py-3 text-sm">
          KYB pendiente: puede recibir depósitos y operar dentro del libro, pero <b>no puede retirar</b> hasta que se active.
        </div>
      )}
      {(c.status === 'suspended' || closed) && (
        <div className="rounded-lg border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          {closed ? 'Cliente cerrado: no admite cambios ni movimientos.' : 'Cliente suspendido: puede recibir depósitos, pero no retirar, transferir ni pagar en compensación.'}
        </div>
      )}

      {/* Cuentas */}
      <Card>
        <CardHeader>
          <CardTitle>Cuentas</CardTitle>
          <CardDescription>Saldo disponible por activo (pasivo de la plataforma con el cliente).</CardDescription>
          {can('ejecutivo') && !closed && missing.length > 0 && (
            <CardAction>
              <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); const v = new FormData(e.currentTarget).get('asset') as string; if (v) openAccount.mutate(v); }}>
                <Select name="asset" aria-label="Activo" className="h-8 w-44">
                  {missing.map((a) => <option key={a.id} value={a.id}>{a.symbol} · {a.id}</option>)}
                </Select>
                <Button size="sm" variant="outline" disabled={openAccount.isPending}><Plus />Abrir</Button>
              </form>
            </CardAction>
          )}
        </CardHeader>
        <CardContent className="grid gap-3">
          <ErrorBox error={openAccount.error} />
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Activo</TableHead>
                <TableHead>Código</TableHead>
                <TableHead className="text-right">Saldo</TableHead>
                <TableHead className="text-right">Movimientos</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {c.accounts.length === 0 && <TableRow><TableCell colSpan={4} className="py-6 text-center text-muted-foreground">Sin cuentas abiertas</TableCell></TableRow>}
              {c.accounts.map((a) => (
                <TableRow key={a.id}>
                  <TableCell><span className="font-medium">{byId(a.asset_id).symbol}</span> <span className="font-mono text-[11px] text-muted-foreground">{a.asset_id}</span></TableCell>
                  <TableCell><span className="inline-flex max-w-72 items-center gap-1"><span className="truncate font-mono text-xs" title={a.code}>{a.code}</span><CopyButton value={a.code} /></span></TableCell>
                  <TableCell className="text-right"><Amount v={a.balance} asset={byId(a.asset_id)} /></TableCell>
                  <TableCell className="text-right"><Link className="text-sm hover:underline" to={`/cuentas/${a.id}`}>Ver</Link></TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <div className="grid gap-6 lg:grid-cols-2">
        {/* Direcciones de depósito */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2"><WalletIcon className="size-4" />Direcciones de depósito</CardTitle>
            <CardDescription>Derivadas (HD) de la semilla de la plataforma; todas siguen acreditando.</CardDescription>
            {can('ejecutivo') && !closed && (
              <CardAction className="flex gap-2">
                {nets.networks.length > 1 && (
                  <Select aria-label="Red de la dirección" className="h-8 w-44 text-xs" value={selNet} onChange={(e) => setDepNet(e.target.value)}>
                    {nets.networks.map((n) => <option key={n.id} value={n.id}>{n.label}</option>)}
                  </Select>
                )}
                <Button size="sm" variant="outline" disabled={depositAddr.isPending} onClick={() => depositAddr.mutate(!!current)}>
                  {depositAddr.isPending ? <Loader2 className="animate-spin" /> : current ? <RefreshCw /> : <Plus />}{current ? 'Rotar' : 'Generar'}
                </Button>
              </CardAction>
            )}
          </CardHeader>
          <CardContent className="grid gap-2">
            <ErrorBox error={depositAddr.error} />
            {wallets.isPending && <Skeleton className="h-10" />}
            {!wallets.isPending && deposits.length === 0 && <p className="text-sm text-muted-foreground">Sin dirección de depósito.</p>}
            {deposits.map((w) => (
              <div key={w.id} className="flex flex-wrap items-center gap-2 rounded-md border px-3 py-2">
                <a className="inline-flex items-center gap-1 font-mono text-xs hover:underline" href={`${nets.explorer(w.network)}/address/${w.address}`} target="_blank" rel="noreferrer noopener" title={w.address}>
                  {shortHex(w.address, 10)}<ExternalLink className="size-3" />
                </a>
                <CopyButton value={w.address} />
                <Badge variant="outline" className="text-[11px]">{nets.label(w.network)}</Badge>
                {w.id === current?.id && <Badge variant="success">Vigente</Badge>}
                {!w.active && <Badge variant="secondary">Inactiva</Badge>}
                <Badge variant={w.webhook_registered ? 'outline' : 'warning'}>{w.webhook_registered ? 'Webhook' : 'Webhook pendiente'}</Badge>
                <span className="ml-auto text-[11px] text-muted-foreground">#{w.derivation_index} · {fmtDate(w.created_at)}</span>
              </div>
            ))}
          </CardContent>
        </Card>

        <WhitelistCard clientId={c.id} network={network} wallets={whitelist} loading={wallets.isPending} explorer={explorer} disabled={closed} onChange={refresh} />
      </div>

      <PortalCard clientId={c.id} disabled={closed} />

      <ClientAssetsCard clientId={c.id} disabled={closed} />

      {/* Obligaciones (compensación) */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2"><Scale className="size-4" />Obligaciones</CardTitle>
          <CardDescription>Lo que el cliente debe o le deben otros clientes; se liquida por el neto en las corridas de compensación.</CardDescription>
          <CardAction className="flex gap-2">
            <Select aria-label="Estado de obligaciones" className="h-8 w-32" value={obStatus} onChange={(e) => setObStatus(e.target.value as 'open' | 'all')}>
              <option value="open">Abiertas</option><option value="all">Todas</option>
            </Select>
            <Button asChild size="sm" variant="outline"><Link to="/compensacion">Compensación</Link></Button>
          </CardAction>
        </CardHeader>
        <CardContent>
          <ObligationsTable params={{ client_id: c.id, status: obStatus === 'open' ? 'open' : undefined }} perspective={c.id} onOpen={setObligation} />
        </CardContent>
      </Card>

      {/* Asientos recientes */}
      <Card>
        <CardHeader>
          <CardTitle>Asientos recientes</CardTitle>
          <CardDescription>Últimos 20 asientos que tocan alguna cuenta del cliente.</CardDescription>
        </CardHeader>
        <CardContent>
          <ErrorBox error={entries.error} />
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Fecha</TableHead>
                <TableHead>Tipo</TableHead>
                <TableHead>Descripción / referencia</TableHead>
                <TableHead className="text-right">Asiento</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {entries.data?.length === 0 && <TableRow><TableCell colSpan={4} className="py-6 text-center text-muted-foreground">Sin movimientos</TableCell></TableRow>}
              {entries.data?.map((e) => (
                <TableRow key={e.id} className="cursor-pointer" onClick={() => setEntryId(e.id)}>
                  <TableCell className="num text-muted-foreground">{fmtDate(e.created_at)}</TableCell>
                  <TableCell><Badge variant="outline">{ENTRY_KIND[e.kind] ?? e.kind}</Badge></TableCell>
                  <TableCell className="max-w-96 truncate text-sm">{e.description ?? <span className="font-mono text-xs">{e.external_ref ?? '—'}</span>}</TableCell>
                  <TableCell className="text-right font-mono text-xs">{e.id.slice(0, 8)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <EditClientDialog client={c} open={editing} onOpenChange={setEditing} onSaved={refresh} />
      <StatusDialog client={c} open={changingStatus} onOpenChange={setChangingStatus} onSaved={refresh} />
      <EntryDialog id={entryId} onClose={() => setEntryId(null)} />
      <ObligationDialog obligation={obligation} onClose={() => setObligation(null)} onOpenRun={(rid) => { setObligation(null); setRunId(rid); }} />
      <RunDialog id={runId} onClose={() => setRunId(null)} />
    </div>
  );
}

function BackLink() {
  return <Link to="/clientes" className="inline-flex w-fit items-center gap-1 text-sm text-muted-foreground hover:text-foreground"><ArrowLeft className="size-4" />Clientes</Link>;
}

function WhitelistCard({ clientId, network, wallets, loading, explorer, disabled, onChange }: {
  clientId: string; network: string; wallets: Wallet[]; loading: boolean; explorer: string; disabled: boolean; onChange: () => void;
}) {
  const { can } = useAuth();
  const originates = useConsoleOriginates();
  const nets = useNetworks();
  const [wlNet, setWlNet] = useState('');
  const [address, setAddress] = useState('');
  const [label, setLabel] = useState('');
  const add = useMutation({
    mutationFn: () => api('/wallets', { method: 'POST', json: { client_id: clientId, chain: 'ethereum', network: wlNet || network, address: address.trim(), purpose: 'withdrawal_whitelist', ...(label.trim() ? { label: label.trim() } : {}) } }),
    onSuccess: () => { setAddress(''); setLabel(''); onChange(); },
  });
  const toggle = useMutation({
    mutationFn: (w: Wallet) => api(`/wallets/${w.id}`, { method: 'PATCH', json: { active: !w.active } }),
    onSuccess: onChange,
  });
  const valid = /^0x[0-9a-fA-F]{40}$/.test(address.trim());
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2"><KeyRound className="size-4" />Lista blanca de retiro</CardTitle>
        <CardDescription>Los retiros solo salen hacia estas direcciones. {originates ? 'Alta y baja: tesorero.' : 'El cliente las da de alta desde su portal (otro usuario suyo las aprueba y esperan antes de usarse); aquí solo se pueden desactivar.'}</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-2">
        {loading && <Skeleton className="h-10" />}
        {!loading && wallets.length === 0 && <p className="text-sm text-muted-foreground">Sin direcciones autorizadas.</p>}
        {wallets.map((w) => (
          <div key={w.id} className="flex flex-wrap items-center gap-2 rounded-md border px-3 py-2">
            <a className="inline-flex items-center gap-1 font-mono text-xs hover:underline" href={`${nets.byId(w.network)?.explorer ?? explorer}/address/${w.address}`} target="_blank" rel="noreferrer noopener" title={w.address}>
              {shortHex(w.address, 10)}<ExternalLink className="size-3" />
            </a>
            <CopyButton value={w.address} />
            <Badge variant="outline" className="text-[11px]">{nets.label(w.network)}</Badge>
            {w.label && <span className="truncate text-sm">{w.label}</span>}
            {w.wl_status === 'pending_approval' ? <Badge variant="warning">Por aprobar (cliente)</Badge>
              : w.active && w.active_from && new Date(w.active_from) > new Date() ? <Badge variant="secondary" title={fmtDate(w.active_from)}>En espera</Badge>
              : <Badge variant={w.active ? 'success' : 'secondary'}>{w.active ? 'Activa' : 'Inactiva'}</Badge>}
            {can('tesorero') && !disabled && (
              <Button size="sm" variant="ghost" className="ml-auto h-7" disabled={toggle.isPending} onClick={() => toggle.mutate(w)}>{w.active ? 'Desactivar' : 'Reactivar'}</Button>
            )}
          </div>
        ))}
        <ErrorBox error={toggle.error} />
        {can('tesorero') && !disabled && originates && (
          <form className="mt-2 grid gap-2 sm:grid-cols-[1fr_140px_140px_auto]" onSubmit={(e) => { e.preventDefault(); add.mutate(); }}>
            <Input aria-label="Dirección" placeholder="0x… (40 hex)" className="font-mono text-xs" value={address} onChange={(e) => setAddress(e.target.value)} aria-invalid={address !== '' && !valid} />
            <Input aria-label="Etiqueta" placeholder="Etiqueta" maxLength={100} value={label} onChange={(e) => setLabel(e.target.value)} />
            <Select aria-label="Red" className="h-9 text-xs" value={wlNet || network} onChange={(e) => setWlNet(e.target.value)}>
              {nets.networks.map((n) => <option key={n.id} value={n.id}>{n.label}</option>)}
            </Select>
            <Button type="submit" size="sm" className="h-9" disabled={!valid || add.isPending}><Plus />Agregar</Button>
          </form>
        )}
        <ErrorBox error={add.error} />
      </CardContent>
    </Card>
  );
}

function EditClientDialog({ client, open, onOpenChange, onSaved }: { client: TClient; open: boolean; onOpenChange: (v: boolean) => void; onSaved: () => void }) {
  const [name, setName] = useState(client.name);
  const [ext, setExt] = useState(client.external_id ?? '');
  useEffect(() => { if (open) { setName(client.name); setExt(client.external_id ?? ''); } }, [open, client]);
  const m = useMutation({
    mutationFn: () => api(`/clients/${client.id}`, { method: 'PATCH', json: { name: name.trim(), external_id: ext.trim() || null } }),
    onSuccess: () => { onSaved(); onOpenChange(false); },
  });
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader><DialogTitle>Editar cliente</DialogTitle><DialogDescription>El cambio queda en la bitácora.</DialogDescription></DialogHeader>
        <form className="grid gap-4" onSubmit={(e: FormEvent) => { e.preventDefault(); m.mutate(); }}>
          <Field label="Nombre o razón social" htmlFor="ec-name"><Input id="ec-name" required minLength={2} maxLength={200} value={name} onChange={(e) => setName(e.target.value)} /></Field>
          <Field label="Id externo (ERP)" htmlFor="ec-ext" hint="Vacío para quitarlo"><Input id="ec-ext" maxLength={100} value={ext} onChange={(e) => setExt(e.target.value)} /></Field>
          <ErrorBox error={m.error} />
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>Cancelar</Button>
            <Button type="submit" disabled={m.isPending || name.trim().length < 2}>{m.isPending && <Loader2 className="animate-spin" />}Guardar</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function StatusDialog({ client, open, onOpenChange, onSaved }: { client: TClient; open: boolean; onOpenChange: (v: boolean) => void; onSaved: () => void }) {
  const { can } = useAuth();
  const options = client.allowed_transitions.filter((s) => s !== 'closed' || can('tesorero'));
  const [status, setStatus] = useState<ClientStatus | ''>('');
  const [reason, setReason] = useState('');
  useEffect(() => { if (open) { setStatus(options[0] ?? ''); setReason(''); } }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
  const needsReason = status === 'suspended' || status === 'closed';
  const m = useMutation({
    mutationFn: () => api(`/clients/${client.id}`, { method: 'PATCH', json: { status, ...(reason.trim() ? { reason: reason.trim() } : {}) } }),
    onSuccess: () => { onSaved(); onOpenChange(false); },
  });
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Cambiar estado</DialogTitle>
          <DialogDescription>Estado actual: {CLIENT_STATUS[client.status].label}. Suspender bloquea retiros, transferencias y pagos; cerrar es definitivo y exige saldos en cero.</DialogDescription>
        </DialogHeader>
        <form className="grid gap-4" onSubmit={(e) => { e.preventDefault(); m.mutate(); }}>
          <Field label="Nuevo estado" htmlFor="st-new">
            <Select id="st-new" value={status} onChange={(e) => setStatus(e.target.value as ClientStatus)}>
              {options.map((s) => <option key={s} value={s}>{CLIENT_STATUS[s].label}</option>)}
            </Select>
          </Field>
          <Field label={needsReason ? 'Motivo (obligatorio)' : 'Motivo (opcional)'} htmlFor="st-reason" hint="Queda registrado en el cliente y en la bitácora">
            <Textarea id="st-reason" maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} required={needsReason} minLength={needsReason ? 5 : undefined} />
          </Field>
          <ErrorBox error={m.error} />
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>Cancelar</Button>
            <Button type="submit" variant={needsReason ? 'destructive' : 'default'} disabled={!status || m.isPending || (needsReason && reason.trim().length < 5)}>
              {m.isPending && <Loader2 className="animate-spin" />}Confirmar
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}


type PortalStatus = { users: number; admins: number; pending_invites: number; active_keys: number };

/** Portal de clientes: 856 solo invita al primer admin; después el cliente administra a su gente y sus llaves. */
function PortalCard({ clientId, disabled }: { clientId: string; disabled: boolean }) {
  const { can } = useAuth();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [email, setEmail] = useState('');
  const [link, setLink] = useState<string | null>(null);
  const status = useQuery({ queryKey: ['portal-status', clientId], queryFn: () => api<PortalStatus>(`/clients/${clientId}/portal`) });
  const invite = useMutation({
    mutationFn: () => api<{ link: string }>(`/clients/${clientId}/portal-invite`, { method: 'POST', json: { email: email.trim() } }),
    onSuccess: (r) => { setLink(window.location.origin + r.link); qc.invalidateQueries({ queryKey: ['portal-status', clientId] }); },
  });
  const close = () => { setOpen(false); setEmail(''); setLink(null); invite.reset(); };
  const s = status.data;
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2"><Users className="size-4" />Portal del cliente</CardTitle>
        <CardDescription>856 invita solo al primer administrador; él invita a su equipo y crea sus llaves de API.</CardDescription>
        {can('tesorero') && !disabled && s && s.admins === 0 && (
          <CardAction>
            <Button size="sm" variant="outline" onClick={() => setOpen(true)}><UserPlus />Invitar primer admin</Button>
          </CardAction>
        )}
      </CardHeader>
      <CardContent>
        {status.isPending && <Skeleton className="h-10" />}
        <ErrorBox error={status.error} />
        {s && s.users > 0 && s.admins < 2 && (
          <div role="status" className="mb-3 flex items-start gap-2 rounded-md border border-warning/60 bg-warning/10 px-3 py-2 text-sm">
            <AlertTriangle className="mt-0.5 size-4 shrink-0" />
            <span>{s.admins === 0 ? 'El portal tiene usuarios pero ningún administrador activo.' : 'El portal tiene un solo administrador.'} Recomiende al cliente invitar a un segundo admin: si el único pierde su acceso, la recuperación pasa por 856.</span>
          </div>
        )}
        {s && (
          <div className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
            <div><div className="text-muted-foreground">Usuarios activos</div><div className="text-lg font-semibold">{s.users}</div></div>
            <div><div className="text-muted-foreground">Administradores</div><div className="text-lg font-semibold">{s.admins}</div></div>
            <div><div className="text-muted-foreground">Invitaciones vigentes</div><div className="text-lg font-semibold">{s.pending_invites}</div></div>
            <div><div className="text-muted-foreground">Llaves de API vigentes</div><div className="text-lg font-semibold">{s.active_keys}</div></div>
          </div>
        )}
      </CardContent>
      <Dialog open={open} onOpenChange={(o) => !o && close()}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Invitar primer administrador</DialogTitle>
            <DialogDescription>El enlace se muestra una sola vez y vence en 72 h. Entrégalo por un canal seguro; el admin deberá activar 2FA al entrar.</DialogDescription>
          </DialogHeader>
          {!link ? (
            <form className="grid gap-3" onSubmit={(e: FormEvent) => { e.preventDefault(); invite.mutate(); }}>
              <Field label="Correo del administrador" htmlFor="pi-email">
                <Input id="pi-email" type="email" required autoComplete="off" value={email} onChange={(e) => setEmail(e.target.value)} />
              </Field>
              <ErrorBox error={invite.error} />
              <DialogFooter>
                <Button type="button" variant="ghost" onClick={close}>Cancelar</Button>
                <Button type="submit" disabled={invite.isPending || !email.trim()}>{invite.isPending && <Loader2 className="animate-spin" />}Generar enlace</Button>
              </DialogFooter>
            </form>
          ) : (
            <div className="grid gap-3">
              <div className="flex items-center gap-2 rounded-md border bg-muted/40 p-2">
                <code className="min-w-0 flex-1 break-all text-xs" data-testid="portal-invite-link">{link}</code>
                <CopyButton value={link} />
              </div>
              <p className="text-sm text-muted-foreground">No se volverá a mostrar. Si se pierde, genera otra: la anterior vence sola.</p>
              <DialogFooter><Button onClick={close}>Listo</Button></DialogFooter>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </Card>
  );
}
