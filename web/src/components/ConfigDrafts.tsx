// Configuración preparada por el ejecutivo y liberada por el tesorero (con 2FA): lista blanca y umbral de aprobación.
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ClipboardCheck, Loader2, Plus } from 'lucide-react';
import { api, opError } from '@/lib/api';
import { formatUnits, parseUnits } from '@/lib/amount';
import { useAuth } from '@/lib/auth';
import { useAssets, useNetworks } from '@/lib/hooks';
import { ErrorBox, Field, fmtDate } from '@/components/common';
import { StepUpDialog } from '@/components/StepUpDialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Textarea } from '@/components/ui/textarea';

type Draft = {
  id: string; client_id: string; kind: 'whitelist' | 'threshold'; status: 'draft' | 'submitted' | 'released' | 'rejected' | 'cancelled';
  payload: { address?: string; network?: string; label?: string | null; asset_id?: string; threshold?: string | null };
  created_by: string; created_at: string; submitted_at: string | null; decided_by: string | null; decided_at: string | null; decision_note: string | null;
};

const STATUS = {
  draft: { label: 'Borrador', variant: 'secondary' }, submitted: { label: 'En tesorería', variant: 'warning' },
  released: { label: 'Liberado', variant: 'success' }, rejected: { label: 'Rechazado', variant: 'destructive' }, cancelled: { label: 'Cancelado', variant: 'secondary' },
} as const;

export function ConfigDraftsCard({ clientId, disabled }: { clientId: string; disabled: boolean }) {
  const { can, operator } = useAuth();
  const qc = useQueryClient();
  const nets = useNetworks();
  const assets = useAssets();
  const q = useQuery({ queryKey: ['config-drafts', clientId], queryFn: () => api<{ drafts: Draft[] }>(`/clients/${clientId}/config-drafts`).then((r) => r.drafts) });
  const [creating, setCreating] = useState(false);
  const [releasing, setReleasing] = useState<Draft | null>(null);
  const [rejecting, setRejecting] = useState<Draft | null>(null);
  const tes = can('tesorero');
  const refresh = () => ['config-drafts', 'client-wallets', 'portal-thresholds'].forEach((k) => qc.invalidateQueries({ queryKey: [k] }));
  const act = useMutation({
    mutationFn: ({ id, verb }: { id: string; verb: 'submit' | 'cancel' }) => api(`/config-drafts/${id}/${verb}`, { method: 'POST', json: {} }),
    onSuccess: refresh,
  });

  const describe = (d: Draft) => {
    if (d.kind === 'whitelist') return `Lista blanca: ${d.payload.address} · ${nets.label(d.payload.network ?? '')}${d.payload.label ? ` · ${d.payload.label}` : ''}`;
    const a = assets.byId(d.payload.asset_id ?? '');
    return d.payload.threshold == null
      ? `Umbral de ${a.symbol}: quitar`
      : `Umbral de ${a.symbol}: ${formatUnits(d.payload.threshold, a.decimals)}`;
  };

  return (
    <Card data-section="config-drafts">
      <CardHeader>
        <CardTitle className="flex items-center gap-2"><ClipboardCheck className="size-4" />Configuración por liberar</CardTitle>
        <CardDescription>
          El ejecutivo prepara la configuración y la envía; un tesorero distinto la libera con 2FA y solo entonces se aplica al cliente.
        </CardDescription>
        {can('ejecutivo') && !disabled && <CardAction><Button size="sm" onClick={() => setCreating(true)}><Plus />Nuevo borrador</Button></CardAction>}
      </CardHeader>
      <CardContent className="grid gap-2">
        <ErrorBox error={q.error ?? opError(act.error)} />
        {q.isPending && <Skeleton className="h-16" />}
        {q.data && !q.data.length && <p className="py-2 text-center text-sm text-muted-foreground">Sin borradores.</p>}
        {q.data?.map((d) => {
          const s = STATUS[d.status];
          const mine = d.created_by === operator?.email;
          return (
            <div key={d.id} data-draft={d.id} className="flex flex-wrap items-center gap-2 rounded-md border px-3 py-2 text-sm">
              <Badge variant={s.variant}>{s.label}</Badge>
              <span className="min-w-0 flex-1 break-all">{describe(d)}</span>
              <span className="text-xs text-muted-foreground">{d.created_by} · {fmtDate(d.created_at)}</span>
              {d.decision_note && <span className="w-full text-xs text-muted-foreground">Motivo: {d.decision_note}</span>}
              <div className="flex gap-1.5">
                {d.status === 'draft' && mine && <Button size="sm" disabled={act.isPending} onClick={() => act.mutate({ id: d.id, verb: 'submit' })}>Enviar a tesorería</Button>}
                {d.status === 'submitted' && tes && !mine && <Button size="sm" onClick={() => setReleasing(d)}>Liberar</Button>}
                {d.status === 'submitted' && tes && <Button size="sm" variant="outline" onClick={() => setRejecting(d)}>Rechazar</Button>}
                {(d.status === 'draft' || d.status === 'submitted') && (mine || tes) && (
                  <Button size="sm" variant="ghost" disabled={act.isPending} onClick={() => act.mutate({ id: d.id, verb: 'cancel' })}>Cancelar</Button>
                )}
              </div>
            </div>
          );
        })}
      </CardContent>
      <CreateDraft clientId={clientId} open={creating} onClose={() => setCreating(false)} onDone={refresh} />
      <StepUpDialog open={!!releasing} title="Liberar configuración"
        description={releasing ? `${describe(releasing)}. Preparada por ${releasing.created_by}; al liberarla se aplica al cliente.` : undefined}
        confirmLabel="Liberar" onClose={() => setReleasing(null)}
        onConfirm={async (code) => { await api(`/config-drafts/${releasing!.id}/release`, { method: 'POST', json: { code } }); refresh(); }} />
      <RejectDraft draft={rejecting} onClose={() => setRejecting(null)} onDone={refresh} />
    </Card>
  );
}

function CreateDraft({ clientId, open, onClose, onDone }: { clientId: string; open: boolean; onClose: () => void; onDone: () => void }) {
  const nets = useNetworks();
  const assets = useAssets();
  const [kind, setKind] = useState<'whitelist' | 'threshold'>('whitelist');
  const [address, setAddress] = useState('');
  const [network, setNetwork] = useState('');
  const [label, setLabel] = useState('');
  const [assetId, setAssetId] = useState('');
  const [amount, setAmount] = useState('');
  const asset = assets.assets.find((a) => a.id === assetId);
  const base = amount.trim() === '' ? null : asset ? parseUnits(amount.trim(), asset.decimals) : null;
  const valid = kind === 'whitelist' ? /^0x[0-9a-fA-F]{40}$/.test(address.trim()) : !!asset && (amount.trim() === '' || (base !== null && base !== '0'));
  const reset = () => { setAddress(''); setLabel(''); setAmount(''); setAssetId(''); };
  const m = useMutation({
    mutationFn: () => api(`/clients/${clientId}/config-drafts`, {
      method: 'POST',
      json: kind === 'whitelist'
        ? { kind, address: address.trim(), network: network || undefined, label: label.trim() || undefined }
        : { kind, asset_id: assetId, threshold: base },
    }),
    onSuccess: () => { reset(); onDone(); onClose(); },
  });
  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) { m.reset(); onClose(); } }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Nuevo borrador de configuración</DialogTitle>
          <DialogDescription>Queda en borrador hasta que lo envíe a tesorería.</DialogDescription>
        </DialogHeader>
        <Field label="Tipo">
          <Select aria-label="Tipo de configuración" value={kind} onChange={(e) => setKind(e.target.value as 'whitelist' | 'threshold')}>
            <option value="whitelist">Dirección de lista blanca</option>
            <option value="threshold">Umbral de aprobación del cliente</option>
          </Select>
        </Field>
        {kind === 'whitelist' ? (
          <>
            <Field label="Dirección"><Input aria-label="Dirección" className="font-mono" value={address} onChange={(e) => setAddress(e.target.value)} placeholder="0x…" /></Field>
            <Field label="Red">
              <Select aria-label="Red" value={network} onChange={(e) => setNetwork(e.target.value)}>
                <option value="">Red principal</option>
                {nets.networks.map((n) => <option key={n.id} value={n.id}>{n.label}</option>)}
              </Select>
            </Field>
            <Field label="Etiqueta (opcional)"><Input aria-label="Etiqueta" maxLength={100} value={label} onChange={(e) => setLabel(e.target.value)} /></Field>
          </>
        ) : (
          <>
            <Field label="Activo">
              <Select aria-label="Activo" value={assetId} onChange={(e) => setAssetId(e.target.value)}>
                <option value="">Seleccione…</option>
                {assets.assets.filter((a) => a.active).map((a) => <option key={a.id} value={a.id}>{a.symbol} · {a.id}</option>)}
              </Select>
            </Field>
            <Field label="Monto del umbral (vacío = quitar umbral)">
              <Input aria-label="Monto del umbral" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />
            </Field>
          </>
        )}
        <ErrorBox error={opError(m.error)} />
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancelar</Button>
          <Button disabled={!valid || m.isPending} onClick={() => m.mutate()}>{m.isPending && <Loader2 className="animate-spin" />}Crear borrador</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function RejectDraft({ draft, onClose, onDone }: { draft: Draft | null; onClose: () => void; onDone: () => void }) {
  const [reason, setReason] = useState('');
  const m = useMutation({
    mutationFn: () => api(`/config-drafts/${draft!.id}/reject`, { method: 'POST', json: { reason: reason.trim() } }),
    onSuccess: () => { setReason(''); onDone(); onClose(); },
  });
  if (!draft) return null;
  return (
    <Dialog open onOpenChange={(v) => { if (!v) { m.reset(); setReason(''); onClose(); } }}>
      <DialogContent>
        <DialogHeader><DialogTitle>Rechazar configuración</DialogTitle><DialogDescription>El ejecutivo verá el motivo.</DialogDescription></DialogHeader>
        <Textarea aria-label="Motivo del rechazo" autoFocus rows={2} maxLength={500} placeholder="Motivo (mín. 5 caracteres)" value={reason} onChange={(e) => setReason(e.target.value)} />
        <ErrorBox error={opError(m.error)} />
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancelar</Button>
          <Button variant="destructive" disabled={reason.trim().length < 5 || m.isPending} onClick={() => m.mutate()}>Rechazar</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
