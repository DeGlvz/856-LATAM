import { useState } from 'react';
import { Link, useParams } from 'react-router';
import { useInfiniteQuery } from '@tanstack/react-query';
import { ArrowLeft, Loader2 } from 'lucide-react';
import { api, type OperatorActivity } from '@/lib/api';
import { ErrorBox, fmtDate } from '@/components/common';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Select } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { label, result } from '@/pages/Audit';

const ROLE_LABEL = { lectura: 'Lectura', ejecutivo: 'Ejecutivo de cuenta', tesorero: 'Tesorero' } as const;

function Stat({ title, value }: { title: string; value: string | number }) {
  return (
    <Card className="py-3"><CardContent className="px-4">
      <div className="text-xs text-muted-foreground">{title}</div>
      <div className="num mt-1 text-lg font-semibold">{value}</div>
    </CardContent></Card>
  );
}

export function OperatorDetail() {
  const { id = '' } = useParams();
  const [action, setAction] = useState('');
  const q = useInfiniteQuery({
    queryKey: ['operator-activity', id, action],
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) => api<OperatorActivity>(`/operators/${id}/activity?limit=100${action ? `&action=${encodeURIComponent(action)}` : ''}${pageParam ? `&cursor=${pageParam}` : ''}`),
    getNextPageParam: (l) => l.next_cursor,
    refetchInterval: 30_000,
  });
  const head = q.data?.pages[0];
  const op = head?.operator;
  const rows = q.data?.pages.flatMap((p) => p.entries) ?? [];
  const kinds = [...new Set(rows.map((e) => e.action))].sort();

  return (
    <div className="mx-auto grid max-w-7xl grid-cols-[minmax(0,1fr)] gap-6">
      <div>
        <Link to="/operadores" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:underline"><ArrowLeft className="size-4" />Operadores</Link>
        {op ? (
          <div className="mt-2 flex flex-wrap items-center gap-3">
            <h1 className="text-xl font-semibold tracking-tight">{op.name}</h1>
            <Badge variant="secondary">{ROLE_LABEL[op.role]}</Badge>
            {op.active ? <Badge variant="success">Activo</Badge> : <Badge variant="outline">Desactivado</Badge>}
            <span className="text-sm text-muted-foreground">{op.email}</span>
          </div>
        ) : <Skeleton className="mt-2 h-7 w-64" />}
      </div>
      <ErrorBox error={q.error} />

      {op && head && (
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
          <Stat title="Último acceso" value={op.last_login_at ? fmtDate(op.last_login_at) : 'Nunca'} />
          <Stat title="2FA" value={op.totp_enabled ? 'Activo' : 'Inactivo'} />
          <Stat title="Sesiones activas" value={op.active_sessions} />
          <Stat title="Acciones (30 días)" value={head.summary.actions_30d} />
          <Stat title="Denegados / fallidos (30 días)" value={head.summary.denied_30d} />
        </div>
      )}

      <Card className="py-2">
        <CardHeader className="px-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <CardTitle className="text-base">Actividad</CardTitle>
            <Select aria-label="Filtrar por acción" className="h-9 w-64" value={action} onChange={(e) => setAction(e.target.value)}>
              <option value="">Todas las acciones</option>
              {action && !kinds.includes(action) && <option value={action}>{label(action)}</option>}
              {kinds.map((k) => <option key={k} value={k}>{label(k)}</option>)}
            </Select>
          </div>
          <p className="text-xs text-muted-foreground">Lo que hizo esta persona y lo que otros hicieron sobre su cuenta (invitaciones, roles, reenvíos). Bitácora completa en Auditoría.</p>
        </CardHeader>
        <CardContent className="px-3">
          <Table>
            <TableHeader><TableRow>
              <TableHead>Fecha</TableHead><TableHead>Actor</TableHead><TableHead>Acción</TableHead><TableHead>Objetivo</TableHead>
              <TableHead>Resultado</TableHead><TableHead>IP</TableHead><TableHead>Detalle</TableHead>
            </TableRow></TableHeader>
            <TableBody>
              {q.isPending && <TableRow><TableCell colSpan={7}><Skeleton className="h-6" /></TableCell></TableRow>}
              {!q.isPending && rows.length === 0 && <TableRow><TableCell colSpan={7} className="py-8 text-center text-muted-foreground">Sin actividad registrada</TableCell></TableRow>}
              {rows.map((e) => {
                const r = result(e);
                const meta = Object.entries(e.metadata ?? {}).filter(([k]) => k !== 'denied').map(([k, v]) => `${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`).join(' · ');
                return (
                  <TableRow key={e.id}>
                    <TableCell className="num whitespace-nowrap text-xs">{fmtDate(e.at)}</TableCell>
                    <TableCell className="max-w-48 truncate text-sm">{e.actor}</TableCell>
                    <TableCell className="text-sm" title={e.action}>{label(e.action)}</TableCell>
                    <TableCell className="max-w-40 truncate font-mono text-xs" title={e.target ?? undefined}>{e.target ? (e.target.length > 18 ? `${e.target.slice(0, 8)}…` : e.target) : '—'}</TableCell>
                    <TableCell><Badge variant={r.variant}>{r.text}</Badge></TableCell>
                    <TableCell className="font-mono text-xs text-muted-foreground">{e.ip ?? '—'}</TableCell>
                    <TableCell className="max-w-64 truncate text-xs text-muted-foreground" title={meta}>{meta || '—'}</TableCell>
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
        </CardContent>
      </Card>
    </div>
  );
}
