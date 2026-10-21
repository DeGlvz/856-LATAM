import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, type AccessRequest, type AccessRequestList, type AccessRequestStatus } from '@/lib/api';
import { CopyButton, ErrorBox, fmtDate } from '@/components/common';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';

const STATUS: Record<AccessRequestStatus, { text: string; variant: 'warning' | 'success' | 'outline' }> = {
  new: { text: 'Nueva', variant: 'warning' },
  contacted: { text: 'Contactada', variant: 'success' },
  closed: { text: 'Cerrada', variant: 'outline' },
};
const VOLUME: Record<string, string> = {
  lt_100k: '< USD 100 mil', '100k_1m': 'USD 100 mil – 1 M', '1m_10m': 'USD 1 M – 10 M', gt_10m: '> USD 10 M',
};
const FILTERS: { value: AccessRequestStatus | ''; label: string }[] = [
  { value: 'new', label: 'Nuevas' }, { value: 'contacted', label: 'Contactadas' }, { value: 'closed', label: 'Cerradas' }, { value: '', label: 'Todas' },
];

/** Solicitudes de acceso que llegan del formulario público de 856latam.com. Ejecutivo o tesorero. */
export function AccessRequests() {
  const [filter, setFilter] = useState<AccessRequestStatus | ''>('new');
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ['access-requests', filter],
    queryFn: () => api<AccessRequestList>(`/console/access-requests${filter ? `?status=${filter}` : ''}`),
    refetchInterval: 60_000,
  });
  const setStatus = useMutation({
    mutationFn: (v: { id: string; status: AccessRequestStatus }) => api<AccessRequest>(`/console/access-requests/${v.id}/status`, { method: 'POST', json: { status: v.status } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['access-requests'] }),
  });

  return (
    <div className="mx-auto grid max-w-7xl grid-cols-[minmax(0,1fr)] gap-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Solicitudes de acceso</h1>
          <p className="text-sm text-muted-foreground">Llegan del formulario «Solicitar acceso» de 856latam.com. Responde por correo y marca su estado.</p>
        </div>
        <div className="flex flex-wrap gap-1.5" role="group" aria-label="Filtrar por estado">
          {FILTERS.map((f) => (
            <Button key={f.label} size="sm" variant={filter === f.value ? 'default' : 'outline'} onClick={() => setFilter(f.value)}>
              {f.label}{f.value === 'new' && q.data?.counts.new ? ` (${q.data.counts.new})` : ''}
            </Button>
          ))}
        </div>
      </div>
      <ErrorBox error={q.error ?? setStatus.error} />
      <Card className="py-2"><CardContent className="px-3">
        <Table>
          <TableHeader><TableRow>
            <TableHead>Recibida</TableHead><TableHead>Contacto</TableHead><TableHead>Empresa y país</TableHead>
            <TableHead>Volumen</TableHead><TableHead>Mensaje</TableHead><TableHead>Estado</TableHead><TableHead />
          </TableRow></TableHeader>
          <TableBody>
            {q.isPending && <TableRow><TableCell colSpan={7}><Skeleton className="h-6" /></TableCell></TableRow>}
            {q.data?.items.length === 0 && <TableRow><TableCell colSpan={7} className="py-8 text-center text-sm text-muted-foreground">Sin solicitudes en este filtro.</TableCell></TableRow>}
            {q.data?.items.map((r) => (
              <TableRow key={r.id} className="align-top">
                <TableCell className="whitespace-nowrap text-xs">{fmtDate(r.created_at)}</TableCell>
                <TableCell>
                  <p className="font-medium">{r.full_name}</p>
                  <p className="flex items-center gap-1 text-xs text-muted-foreground"><a className="underline" href={`mailto:${r.email}`}>{r.email}</a><CopyButton value={r.email} /></p>
                </TableCell>
                <TableCell><p className="font-medium">{r.company}</p><p className="text-xs text-muted-foreground">{r.country}</p></TableCell>
                <TableCell className="whitespace-nowrap text-xs">{VOLUME[r.volume] ?? r.volume}</TableCell>
                <TableCell className="max-w-xs text-xs whitespace-pre-wrap text-muted-foreground">{r.message || '—'}</TableCell>
                <TableCell>
                  <Badge variant={STATUS[r.status].variant}>{STATUS[r.status].text}</Badge>
                  {r.handled_by && <p className="mt-1 text-[11px] text-muted-foreground">{r.handled_by}</p>}
                </TableCell>
                <TableCell className="text-right">
                  <div className="flex justify-end gap-1.5">
                    {r.status !== 'contacted' && <Button size="sm" variant="outline" disabled={setStatus.isPending} onClick={() => setStatus.mutate({ id: r.id, status: 'contacted' })}>Contactada</Button>}
                    {r.status !== 'closed' && <Button size="sm" variant="ghost" disabled={setStatus.isPending} onClick={() => setStatus.mutate({ id: r.id, status: 'closed' })}>Cerrar</Button>}
                    {r.status === 'closed' && <Button size="sm" variant="ghost" disabled={setStatus.isPending} onClick={() => setStatus.mutate({ id: r.id, status: 'new' })}>Reabrir</Button>}
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent></Card>
    </div>
  );
}
