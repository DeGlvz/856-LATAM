// Portal fase 3 — lista blanca: solo a estas direcciones se puede enviar. Un usuario la pide, OTRO la aprueba con 2FA
// y queda en espera (WHITELIST_COOLDOWN_HOURS) antes de poder usarse. El servidor valida todo; aquí solo se guía.
import { useEffect, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, ExternalLink, Loader2, Plus, Trash2 } from 'lucide-react';
import { explorerFor, papi, roleAtLeast, WL_STATE, type WlEntry } from '../api';
import { usePortal } from '../auth';
import { CodeInput, CopyButton, ErrorBox, Field, fmtDate } from '@/components/common';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';

/** Cuenta regresiva hasta que la dirección pueda usarse. */
export function Countdown({ until, prefix = 'usable en' }: { until: string; prefix?: string }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 30_000); return () => clearInterval(t); }, []);
  const ms = new Date(until).getTime() - now;
  if (ms <= 0) return <span className="text-xs text-muted-foreground">lista</span>;
  const total = Math.ceil(ms / 60_000), h = Math.floor(total / 60), m = total % 60;
  return <span className="text-xs text-muted-foreground" title={fmtDate(until)}>{prefix} {[h && `${h} h`, (m || !h) && `${m} min`].filter(Boolean).join(' ')}</span>;
}

export function Whitelist() {
  const { me, role } = usePortal();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['p-whitelist'], queryFn: () => papi<{ cooldown_hours: number; entries: WlEntry[] }>('/whitelist'), refetchInterval: 60_000 });
  const [adding, setAdding] = useState(false);
  const [approving, setApproving] = useState<WlEntry | null>(null);
  const [removing, setRemoving] = useState<WlEntry | null>(null);
  const canRequest = roleAtLeast(role, 'operator');
  const canApprove = roleAtLeast(role, 'approver');
  const remove = useMutation({
    mutationFn: (id: string) => papi(`/whitelist/${id}/remove`, { method: 'POST', json: {} }),
    onSuccess: () => { setRemoving(null); qc.invalidateQueries({ queryKey: ['p-whitelist'] }); },
  });
  const hours = q.data?.cooldown_hours ?? 24;
  const rows = q.data?.entries ?? [];

  return (
    <div className="mx-auto grid max-w-6xl grid-cols-[minmax(0,1fr)] gap-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Lista blanca</h1>
          <p className="text-sm text-muted-foreground">Solo puede enviar fondos a estas direcciones. Cada alta la aprueba otro usuario con 2FA y queda en espera {hours} h antes de poder usarse.</p>
        </div>
        {canRequest && <Button onClick={() => setAdding(true)}><Plus />Agregar dirección</Button>}
      </div>
      <ErrorBox error={q.error ?? remove.error} />
      <Card className="py-2"><CardContent className="px-3">
        {q.isPending ? <Skeleton className="h-24" /> : (
          <div className="overflow-x-auto">
            <Table aria-label="Lista blanca">
              <TableHeader><TableRow><TableHead>Dirección</TableHead><TableHead>Etiqueta</TableHead><TableHead>Estado</TableHead><TableHead>Solicitada</TableHead><TableHead /></TableRow></TableHeader>
              <TableBody>
                {!rows.length && <TableRow><TableCell colSpan={5} className="py-8 text-center text-muted-foreground">Aún no hay direcciones.</TableCell></TableRow>}
                {rows.map((w) => {
                  const s = WL_STATE[w.state];
                  return (
                    <TableRow key={w.id} data-wl={w.address} className={w.state === 'removed' ? 'opacity-60' : undefined}>
                      <TableCell>
                        <div className="flex items-center gap-1"><code className="font-mono text-xs break-all">{w.address}</code><CopyButton value={w.address} />
                          <a href={`${explorerFor(w.network)}/address/${w.address}`} target="_blank" rel="noreferrer noopener" aria-label="Ver en el explorador" className="text-muted-foreground"><ExternalLink className="size-3" /></a></div>
                      </TableCell>
                      <TableCell className="text-sm">{w.label ?? <span className="text-muted-foreground">—</span>}</TableCell>
                      <TableCell>
                        <div className="flex flex-wrap items-center gap-2"><Badge variant={s.v}>{s.t}</Badge>{w.state === 'cooling' && w.active_from && <Countdown until={w.active_from} />}</div>
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground">{fmtDate(w.requested_at)}{w.requested_by_me && ' · por usted'}</TableCell>
                      <TableCell className="text-right whitespace-nowrap">
                        {w.state === 'pending_approval' && canApprove && !w.requested_by_me && <Button size="sm" variant="outline" onClick={() => setApproving(w)}><Check />Aprobar</Button>}
                        {w.state === 'pending_approval' && w.requested_by_me && <span className="text-xs text-muted-foreground">Debe aprobarla otro usuario</span>}
                        {w.state !== 'removed' && canApprove && <Button size="sm" variant="ghost" className="text-destructive" onClick={() => setRemoving(w)}><Trash2 />Retirar</Button>}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent></Card>
      {me && <AddDialog open={adding} onClose={() => setAdding(false)} />}
      <ApproveDialog entry={approving} hours={hours} onClose={() => setApproving(null)} />
      <Dialog open={!!removing} onOpenChange={(v) => !v && setRemoving(null)}>
        <DialogContent>
          <DialogHeader><DialogTitle>Retirar dirección</DialogTitle>
            <DialogDescription>Ya no podrá usarse para nuevas salidas. Las salidas en curso hacia ella fallarán la validación de 856. Para volver a usarla habrá que pedir y aprobar otra alta.</DialogDescription></DialogHeader>
          <code className="font-mono text-xs break-all">{removing?.address}</code>
          <ErrorBox error={remove.error} />
          <DialogFooter><Button variant="outline" onClick={() => setRemoving(null)}>Cancelar</Button>
            <Button variant="destructive" disabled={remove.isPending} onClick={() => remove.mutate(removing!.id)}>Retirar</Button></DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function AddDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const [address, setAddress] = useState('');
  const [label, setLabel] = useState('');
  useEffect(() => { if (open) { setAddress(''); setLabel(''); m.reset(); } }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
  const m = useMutation({
    mutationFn: () => papi<WlEntry>('/whitelist', { method: 'POST', json: { address: address.trim(), ...(label.trim() ? { label: label.trim() } : {}) } }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['p-whitelist'] }); onClose(); },
  });
  const valid = /^0x[0-9a-fA-F]{40}$/.test(address.trim());
  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent>
        <DialogHeader><DialogTitle>Agregar dirección</DialogTitle>
          <DialogDescription>Queda «Por aprobar» hasta que otro usuario con rol Aprobador o Administrador la apruebe con 2FA.</DialogDescription></DialogHeader>
        <form className="grid gap-4" onSubmit={(e: FormEvent) => { e.preventDefault(); if (valid) m.mutate(); }}>
          <Field label="Dirección (red Ethereum)" htmlFor="wl-addr" hint="Verifíquela carácter por carácter con su destinatario.">
            <Input id="wl-addr" autoFocus className="font-mono text-xs" placeholder="0x…" value={address} onChange={(e) => setAddress(e.target.value)} aria-invalid={address !== '' && !valid} /></Field>
          <Field label="Etiqueta (opcional)" htmlFor="wl-label" hint="Para reconocerla, p. ej. «Proveedor ACME»."><Input id="wl-label" value={label} onChange={(e) => setLabel(e.target.value)} maxLength={80} /></Field>
          <ErrorBox error={m.error} />
          <DialogFooter><Button type="button" variant="outline" onClick={onClose}>Cancelar</Button>
            <Button type="submit" disabled={!valid || m.isPending}>{m.isPending && <Loader2 className="animate-spin" />}Solicitar alta</Button></DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function ApproveDialog({ entry, hours, onClose }: { entry: WlEntry | null; hours: number; onClose: () => void }) {
  const qc = useQueryClient();
  const [code, setCode] = useState('');
  useEffect(() => { setCode(''); m.reset(); }, [entry]); // eslint-disable-line react-hooks/exhaustive-deps
  const m = useMutation({
    mutationFn: () => papi<WlEntry>(`/whitelist/${entry!.id}/approve`, { method: 'POST', json: { code } }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['p-whitelist'] }); onClose(); },
  });
  return (
    <Dialog open={!!entry} onOpenChange={(v) => !v && onClose()}>
      <DialogContent>
        <DialogHeader><DialogTitle>Aprobar dirección</DialogTitle>
          <DialogDescription>Confirme que la dirección es correcta. Podrá usarse dentro de {hours} h.</DialogDescription></DialogHeader>
        <div className="grid gap-1 rounded-md border p-3"><code className="font-mono text-sm break-all">{entry?.address}</code>{entry?.label && <span className="text-xs text-muted-foreground">{entry.label}</span>}</div>
        <Field label="Código 2FA"><CodeInput label="Código 2FA para aprobar" autoFocus value={code} onChange={setCode} /></Field>
        <ErrorBox error={m.error} />
        <DialogFooter><Button variant="outline" onClick={onClose}>Cancelar</Button>
          <Button disabled={code.length !== 6 || m.isPending} onClick={() => m.mutate()}>{m.isPending && <Loader2 className="animate-spin" />}Aprobar</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
