// Multi-red: activos habilitados para un cliente, agrupados por red. El Tesorero los cambia con 2FA;
// el Ejecutivo los solicita (queda en Aprobaciones). Deshabilitar con saldo no se permite: se usa «Solo salida».
import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Coins, Loader2 } from 'lucide-react';
import { api, ASSET_STATUS, type ClientAssetRow, type ClientAssetStatus } from '@/lib/api';
import { formatUnits } from '@/lib/amount';
import { useAuth } from '@/lib/auth';
import { useNetworks } from '@/lib/hooks';
import { CodeInput, ErrorBox, Field } from '@/components/common';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Select } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Textarea } from '@/components/ui/textarea';

const ACTION: Record<ClientAssetStatus, 'enable' | 'exit_only' | 'disable'> = { enabled: 'enable', exit_only: 'exit_only', disabled: 'disable' };

export function ClientAssetsCard({ clientId, disabled }: { clientId: string; disabled: boolean }) {
  const { can } = useAuth();
  const nets = useNetworks();
  const q = useQuery({ queryKey: ['client-assets', clientId], queryFn: () => api<{ assets: ClientAssetRow[] }>(`/clients/${clientId}/assets`).then((r) => r.assets) });
  const [edit, setEdit] = useState<{ a: ClientAssetRow; to: ClientAssetStatus } | null>(null);
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [bulkEdit, setBulkEdit] = useState<{ assets: ClientAssetRow[]; group?: string } | null>(null);
  const groups = useMemo(() => {
    const m = new Map<string, ClientAssetRow[]>();
    for (const a of q.data ?? []) m.set(a.network, [...(m.get(a.network) ?? []), a]);
    return [...m.entries()];
  }, [q.data]);
  const tes = can('tesorero'), eje = can('ejecutivo');
  const canEdit = !disabled && (tes || eje);
  const toggleSelected = (assetId: string) => setSelected((prev) => {
    const next = new Set(prev);
    if (next.has(assetId)) next.delete(assetId); else next.add(assetId);
    return next;
  });

  return (
    <Card data-section="client-assets">
      <CardHeader>
        <CardTitle className="flex items-center gap-2"><Coins className="size-4" />Activos habilitados</CardTitle>
        <CardDescription>
          Solo opera lo habilitado. «Solo salida» permite retirar o compensar lo que tiene, sin recibir más. {tes ? 'Los cambios piden 2FA.' : 'Los cambios los aprueba un tesorero.'}
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        <ErrorBox error={q.error} />
        {canEdit && selected.size > 0 && (
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border bg-muted/30 px-3 py-2">
            <span className="text-sm">{selected.size} activo(s) seleccionado(s)</span>
            <div className="flex gap-2">
              <Button variant="outline" size="sm" onClick={() => setSelected(new Set())}>Quitar selección</Button>
              <Button size="sm" onClick={() => setBulkEdit({ assets: (q.data ?? []).filter((a) => selected.has(a.asset_id)) })}>
                Editar selección
              </Button>
            </div>
          </div>
        )}
        {q.isPending && <Skeleton className="h-24" />}
        {groups.map(([network, rows]) => (
          <div key={network} className="grid gap-1.5">
            <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
              <span>{nets.label(network)}</span><span className="font-mono">{network}</span>
              {!rows[0].network_enabled && <Badge variant="outline">Red no encendida</Badge>}
              {canEdit && rows.some((a) => tes || !a.pending_request) && (
                <Button variant="outline" size="sm" className="h-7 text-xs"
                  aria-label={`Editar activos de ${nets.label(network)}`}
                  onClick={() => setBulkEdit({ assets: rows.filter((a) => tes || !a.pending_request), group: nets.label(network) })}>
                  Editar grupo
                </Button>
              )}
              {canEdit && <label className="ml-auto flex items-center gap-1.5">
                <input type="checkbox" aria-label={`Seleccionar activos de ${nets.label(network)}`} className="size-4 accent-primary"
                  checked={rows.filter((a) => tes || !a.pending_request).length > 0 && rows.filter((a) => tes || !a.pending_request).every((a) => selected.has(a.asset_id))}
                  onChange={(e) => {
                    const checked = e.target.checked;
                    setSelected((prev) => {
                      const next = new Set(prev);
                      for (const a of rows) if (tes || !a.pending_request) {
                        if (checked) next.add(a.asset_id); else next.delete(a.asset_id);
                      }
                      return next;
                    });
                  }} />
                Seleccionar red
              </label>}
            </div>
            {rows.map((a) => {
              const s = ASSET_STATUS[a.status];
              return (
                <div key={a.asset_id} data-asset={a.asset_id} className="flex flex-wrap items-center gap-2 rounded-md border px-3 py-1.5 text-sm">
                  {canEdit && <input type="checkbox" aria-label={`Seleccionar activo ${a.asset_id}`} className="size-4 accent-primary"
                    checked={selected.has(a.asset_id)} disabled={!tes && !!a.pending_request}
                    onChange={() => toggleSelected(a.asset_id)} />}
                  <span className="w-16 font-medium">{a.symbol}</span>
                  <span className="font-mono text-xs text-muted-foreground">{a.asset_id}</span>
                  <Badge variant={s.variant}>{s.label}</Badge>
                  {a.pending_request && <Badge variant="secondary">Solicitud pendiente</Badge>}
                  {a.balance !== '0' && <span className="num text-xs text-muted-foreground">saldo {formatUnits(a.balance, a.decimals)}</span>}
                  {!disabled && (tes || eje) && (
                    <Select aria-label={`Cambiar ${a.asset_id}`} className="ml-auto h-7 w-40 text-xs" value={a.status}
                      disabled={!tes && !!a.pending_request}
                      onChange={(e) => setEdit({ a, to: e.target.value as ClientAssetStatus })}>
                      {(Object.keys(ASSET_STATUS) as ClientAssetStatus[]).map((k) => <option key={k} value={k}>{ASSET_STATUS[k].label}</option>)}
                    </Select>
                  )}
                </div>
              );
            })}
          </div>
        ))}
      </CardContent>
      <ChangeDialog clientId={clientId} edit={edit} direct={tes} onClose={() => setEdit(null)} />
      <BulkChangeDialog clientId={clientId} assets={bulkEdit?.assets ?? null} group={bulkEdit?.group} direct={tes}
        onClose={() => setBulkEdit(null)} onSuccess={() => setSelected(new Set())} />
    </Card>
  );
}

function BulkChangeDialog({ clientId, assets, group, direct, onClose, onSuccess }: {
  clientId: string; assets: ClientAssetRow[] | null; group?: string; direct: boolean; onClose: () => void; onSuccess: () => void;
}) {
  const qc = useQueryClient();
  const [to, setTo] = useState<ClientAssetStatus>('enabled');
  const [code, setCode] = useState('');
  const [reason, setReason] = useState('');
  const changed = assets?.filter((a) => a.status !== to) ?? [];
  const m = useMutation({
    mutationFn: () => direct
      ? api(`/clients/${clientId}/assets/bulk`, { method: 'PUT', json: { asset_ids: changed.map((a) => a.asset_id), status: to, code } })
      : api(`/clients/${clientId}/asset-requests/bulk`, { method: 'POST', json: { asset_ids: changed.map((a) => a.asset_id), action: ACTION[to], reason: reason.trim() } }),
    onSuccess: () => {
      ['client-assets', 'asset-requests', 'summary'].forEach((k) => qc.invalidateQueries({ queryKey: [k] }));
      setCode(''); setReason(''); setTo('enabled'); onSuccess(); onClose();
    },
  });
  if (!assets?.length) return null;
  return (
    <Dialog open onOpenChange={(v) => { if (!v) { m.reset(); setCode(''); setReason(''); setTo('enabled'); onClose(); } }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{group
            ? direct ? `Editar activos de ${group}` : `Solicitar cambio para ${group}`
            : direct ? 'Editar activos seleccionados' : 'Solicitar cambio masivo'}</DialogTitle>
          <DialogDescription>
            Cambiarán {changed.length} de {assets.length} activos {group ? `del grupo ${group}` : 'seleccionados'}: {changed.map((a) => a.asset_id).join(', ') || 'ninguno; todos ya tienen ese estado'}.{' '}
            {direct ? 'El cambio se aplica completo o no se aplica.' : 'Se enviará una solicitud por activo para aprobación del tesorero.'}
            {to === 'disabled' && ' Solo se deshabilitan activos sin saldo ni operaciones abiertas.'}
            {to === 'exit_only' && ' El cliente podrá retirar o compensar, pero no recibir depósitos nuevos.'}
          </DialogDescription>
        </DialogHeader>
        <Field label="Nuevo estado">
          <Select aria-label="Nuevo estado para los activos seleccionados" value={to} onChange={(e) => setTo(e.target.value as ClientAssetStatus)}>
            {(Object.keys(ASSET_STATUS) as ClientAssetStatus[]).map((k) => <option key={k} value={k}>{ASSET_STATUS[k].label}</option>)}
          </Select>
        </Field>
        {direct
          ? <Field label="Código 2FA"><CodeInput label="Código 2FA para cambiar los activos seleccionados" autoFocus value={code} onChange={setCode} /></Field>
          : <Textarea aria-label="Motivo de la solicitud" autoFocus rows={2} maxLength={300} placeholder="Motivo (mín. 5 caracteres)" value={reason} onChange={(e) => setReason(e.target.value)} />}
        <ErrorBox error={m.error} />
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancelar</Button>
          <Button disabled={changed.length === 0 || m.isPending || (direct ? code.length !== 6 : reason.trim().length < 5)} onClick={() => m.mutate()}>
            {m.isPending && <Loader2 className="animate-spin" />}{direct ? 'Aplicar a todos' : 'Enviar solicitudes'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ChangeDialog({ clientId, edit, direct, onClose }: { clientId: string; edit: { a: ClientAssetRow; to: ClientAssetStatus } | null; direct: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const [code, setCode] = useState('');
  const [reason, setReason] = useState('');
  const m = useMutation({
    mutationFn: () => direct
      ? api(`/clients/${clientId}/assets/${edit!.a.asset_id}`, { method: 'PUT', json: { status: edit!.to, code } })
      : api(`/clients/${clientId}/asset-requests`, { method: 'POST', json: { asset_id: edit!.a.asset_id, action: ACTION[edit!.to], reason: reason.trim() } }),
    onSuccess: () => { ['client-assets', 'asset-requests', 'summary'].forEach((k) => qc.invalidateQueries({ queryKey: [k] })); setCode(''); setReason(''); onClose(); },
  });
  if (!edit) return null;
  const same = edit.to === edit.a.status;
  return (
    <Dialog open onOpenChange={(v) => { if (!v) { m.reset(); setCode(''); setReason(''); onClose(); } }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{direct ? 'Cambiar activo' : 'Solicitar cambio'} · {edit.a.asset_id}</DialogTitle>
          <DialogDescription>
            {ASSET_STATUS[edit.a.status].label} → <b>{ASSET_STATUS[edit.to].label}</b>.{' '}
            {edit.to === 'disabled' && 'Solo procede sin saldo ni operaciones abiertas.'}
            {edit.to === 'exit_only' && 'El cliente podrá retirar o compensar, pero un depósito nuevo quedará en revisión.'}
          </DialogDescription>
        </DialogHeader>
        {direct
          ? <Field label="Código 2FA"><CodeInput label="Código 2FA para cambiar el activo" autoFocus value={code} onChange={setCode} /></Field>
          : <Textarea aria-label="Motivo de la solicitud" autoFocus rows={2} maxLength={300} placeholder="Motivo (mín. 5 caracteres)" value={reason} onChange={(e) => setReason(e.target.value)} />}
        <ErrorBox error={m.error} />
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancelar</Button>
          <Button disabled={same || m.isPending || (direct ? code.length !== 6 : reason.trim().length < 5)} onClick={() => m.mutate()}>
            {m.isPending && <Loader2 className="animate-spin" />}{direct ? 'Aplicar' : 'Enviar solicitud'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
