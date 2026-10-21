import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { Download, Loader2, X } from 'lucide-react';
import { api, type AuditEntry } from '@/lib/api';
import { ErrorBox, fmtDate } from '@/components/common';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';

// Nombres legibles para las acciones más comunes (el resto se muestra tal cual: método + ruta)
const ACTION: Record<string, string> = {
  login: 'Inicio de sesión', login_failed: 'Login fallido', login_mfa_challenge: 'Contraseña correcta, pide 2FA', login_mfa_failed: 'Código 2FA fallido',
  logout: 'Cierre de sesión', totp_enabled: '2FA activado', totp_disabled: '2FA desactivado', totp_reset: '2FA restablecido', operator_bootstrap: 'Operador inicial',
  'POST /v1/withdrawals': 'Solicitud de retiro', 'POST /v1/withdrawals/:id/approve': 'Aprobación de retiro', 'POST /v1/withdrawals/:id/reject': 'Rechazo de retiro',
  'POST /v1/withdrawals/:id/cancel': 'Cancelación de retiro', 'POST /v1/netting/runs': 'Solicitud de corrida',
  'POST /v1/netting/runs/:id/approve': 'Aprobación de corrida', 'POST /v1/netting/runs/:id/reject': 'Rechazo de corrida',
  'POST /v1/obligations': 'Alta de obligación', 'POST /v1/obligations/:id/cancel': 'Cancelación de obligación',
  'PATCH /v1/clients/:id': 'Cambio de cliente', 'POST /v1/clients': 'Alta de cliente', 'POST /v1/entries': 'Asiento manual',
  'POST /v1/wallets': 'Alta de wallet', 'PATCH /v1/wallets/:id': 'Cambio de wallet', 'POST /v1/operators/:id/totp/reset': 'Restablecer 2FA de operador',
  operator_invite_created: 'Invitación de operador', operator_invite_revoked: 'Invitación revocada', operator_invite_resent: 'Invitación reenviada',
  operator_invite_accepted: 'Invitación aceptada', operator_access_resent: 'Acceso reenviado', operator_role_changed: 'Cambio de rol de operador',
  operator_deactivated: 'Operador desactivado', operator_reactivated: 'Operador reactivado',
  config_draft_created: 'Borrador de configuración', config_draft_submitted: 'Borrador enviado a tesorería', config_draft_cancelled: 'Borrador retirado',
  config_draft_released: 'Configuración liberada', config_draft_rejected: 'Configuración rechazada',
};
export const label = (a: string) => ACTION[a] ?? a;

export function result(e: AuditEntry): { text: string; variant: 'success' | 'destructive' | 'warning' | 'outline' } {
  if (e.status == null) return { text: '—', variant: 'outline' };
  if (e.status === 403 || e.action.endsWith('failed')) return { text: e.status === 403 ? 'Denegado' : 'Fallido', variant: 'warning' };
  return e.status < 400 ? { text: String(e.status), variant: 'success' } : { text: String(e.status), variant: 'destructive' };
}

const csvCell = (v: unknown) => { const s = v == null ? '' : typeof v === 'string' ? v : JSON.stringify(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };

export function Audit() {
  const [sp, setSp] = useSearchParams();
  const set = (k: string, v: string | null) => { const n = new URLSearchParams(sp); if (v) n.set(k, v); else n.delete(k); setSp(n, { replace: true }); };
  const f = { actor: sp.get('actor') ?? '', action: sp.get('action') ?? '', result: sp.get('result') ?? '', target: sp.get('target') ?? '', from: sp.get('from') ?? '', to: sp.get('to') ?? '' };
  const [actor, setActor] = useState(f.actor);
  const [target, setTarget] = useState(f.target);
  useEffect(() => { const t = setTimeout(() => { set('actor', actor.trim() || null); }, 300); return () => clearTimeout(t); }, [actor]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { const t = setTimeout(() => { set('target', target.trim() || null); }, 300); return () => clearTimeout(t); }, [target]); // eslint-disable-line react-hooks/exhaustive-deps

  const actions = useQuery({ queryKey: ['audit-actions'], queryFn: () => api<{ actions: { action: string; n: number }[] }>('/audit/actions').then((r) => r.actions), staleTime: 60_000 });
  const params = new URLSearchParams({ limit: '100' });
  if (f.actor) params.set('actor', f.actor);
  if (f.action) params.set('action', f.action);
  if (f.result) params.set('result', f.result);
  if (f.target) params.set('target', f.target);
  if (f.from) params.set('from', new Date(f.from).toISOString());
  if (f.to) params.set('to', new Date(new Date(f.to).getTime() + 86_400_000).toISOString()); // hasta el fin del día
  const q = useInfiniteQuery({
    queryKey: ['audit', params.toString()],
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) => api<{ entries: AuditEntry[]; next_cursor: string | null }>(`/audit?${params}${pageParam ? `&cursor=${pageParam}` : ''}`),
    getNextPageParam: (l) => l.next_cursor,
    refetchInterval: 30_000,
  });
  const rows = q.data?.pages.flatMap((p) => p.entries) ?? [];
  const filtered = Object.values(f).some(Boolean);

  const exportCsv = () => {
    const head = ['id', 'fecha', 'actor', 'accion', 'objetivo', 'estado', 'ip', 'detalle'];
    const lines = rows.map((e) => [e.id, e.at, e.actor, e.action, e.target, e.status, e.ip, e.metadata && Object.keys(e.metadata).length ? e.metadata : ''].map(csvCell).join(','));
    const blob = new Blob([`﻿${[head.join(','), ...lines].join('\n')}`], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = `bitacora-856-${new Date().toISOString().slice(0, 10)}.csv`; a.click();
    URL.revokeObjectURL(a.href);
  };

  return (
    <div className="mx-auto grid max-w-7xl grid-cols-[minmax(0,1fr)] gap-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Auditoría</h1>
          <p className="text-sm text-muted-foreground">Bitácora inmutable: quién hizo qué, cuándo y desde dónde. Solo tesorería.</p>
        </div>
        <Button variant="outline" onClick={exportCsv} disabled={!rows.length}><Download />Exportar CSV ({rows.length})</Button>
      </div>

      <Card className="py-2"><CardContent className="grid gap-3 px-3">
        <div className="grid gap-2 pt-2 sm:grid-cols-2 lg:grid-cols-[1fr_1.4fr_auto_1fr_auto_auto_auto]">
          <Input aria-label="Actor" placeholder="Actor (correo)" className="h-9" value={actor} onChange={(e) => setActor(e.target.value)} />
          <Select aria-label="Acción" className="h-9" value={f.action} onChange={(e) => set('action', e.target.value || null)}>
            <option value="">Todas las acciones</option>
            {actions.data?.map((a) => <option key={a.action} value={a.action}>{label(a.action)} ({a.n})</option>)}
          </Select>
          <Select aria-label="Resultado" className="h-9 lg:w-48" value={f.result} onChange={(e) => set('result', e.target.value || null)}>
            <option value="">Cualquier resultado</option><option value="ok">Correcto</option><option value="error">Error</option><option value="denied">Denegado / fallido</option>
          </Select>
          <Input aria-label="Objetivo" placeholder="Objetivo (id o correo)" className="h-9" value={target} onChange={(e) => setTarget(e.target.value)} />
          <Input aria-label="Desde" type="date" className="h-9 lg:w-40" value={f.from} onChange={(e) => set('from', e.target.value || null)} />
          <Input aria-label="Hasta" type="date" className="h-9 lg:w-40" value={f.to} onChange={(e) => set('to', e.target.value || null)} />
          {filtered && <Button variant="ghost" className="h-9" onClick={() => { setActor(''); setTarget(''); setSp(new URLSearchParams(), { replace: true }); }}><X />Limpiar</Button>}
        </div>
        <ErrorBox error={q.error} />
        <Table>
          <TableHeader><TableRow>
            <TableHead>Fecha</TableHead><TableHead>Actor</TableHead><TableHead>Acción</TableHead><TableHead>Objetivo</TableHead>
            <TableHead>Resultado</TableHead><TableHead>IP</TableHead><TableHead>Detalle</TableHead>
          </TableRow></TableHeader>
          <TableBody>
            {q.isPending && <TableRow><TableCell colSpan={7}><Skeleton className="h-6" /></TableCell></TableRow>}
            {!q.isPending && rows.length === 0 && <TableRow><TableCell colSpan={7} className="py-8 text-center text-muted-foreground">Sin registros</TableCell></TableRow>}
            {rows.map((e) => {
              const r = result(e);
              const meta = Object.entries(e.metadata ?? {}).filter(([k]) => k !== 'denied');
              return (
                <TableRow key={e.id}>
                  <TableCell className="num whitespace-nowrap text-xs">{fmtDate(e.at)}</TableCell>
                  <TableCell className="max-w-48 truncate text-sm"><button type="button" className="hover:underline" onClick={() => setActor(e.actor)}>{e.actor}</button></TableCell>
                  <TableCell className="text-sm"><button type="button" className="text-left hover:underline" title={e.action} onClick={() => set('action', e.action)}>{label(e.action)}</button></TableCell>
                  <TableCell className="max-w-40 truncate font-mono text-xs" title={e.target ?? undefined}>{e.target ? <button type="button" className="hover:underline" onClick={() => setTarget(e.target!)}>{e.target.length > 18 ? `${e.target.slice(0, 8)}…` : e.target}</button> : '—'}</TableCell>
                  <TableCell><Badge variant={r.variant}>{r.text}</Badge></TableCell>
                  <TableCell className="font-mono text-xs text-muted-foreground">{e.ip ?? '—'}</TableCell>
                  <TableCell className="max-w-64 truncate text-xs text-muted-foreground" title={meta.map(([k, v]) => `${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`).join(' · ')}>
                    {meta.length ? meta.map(([k, v]) => `${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`).join(' · ') : '—'}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
        {q.hasNextPage && (
          <div className="flex justify-center py-3">
            <Button variant="outline" size="sm" onClick={() => q.fetchNextPage()} disabled={q.isFetchingNextPage}>{q.isFetchingNextPage && <Loader2 className="animate-spin" />}Cargar más</Button>
          </div>
        )}
      </CardContent></Card>
    </div>
  );
}
