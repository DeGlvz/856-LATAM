import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { ErrorBox, Field } from '@/components/common';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';

type Mode = 'manual' | 'automatic' | 'scheduled';
type Window = { days: number[]; start: string; end: string };
type Policy = { mode: Mode; interval_minutes: number; timezone: 'UTC'; windows: Window[]; revision: number; next_due_at: string | null };
type Run = {
  id: string; trigger: Mode; started_at: string; finished_at: string | null; status: string;
  networks: Record<string, Record<string, string>>; error: string | null;
};
type Detail = {
  client: { id: string; name: string; status: string }; policy: Policy; runs: Run[];
  usage: { metric: string; qty: string }[]; worker_enabled: boolean; setup_required: boolean;
};
const labels = { manual: 'Manual', automatic: 'Automático', scheduled: 'Programado / horarios definidos' };
const days = ['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb'];
const utc = (date: string | null | undefined) => date ? new Date(date).toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, ' UTC') : '—';

export function Worker() {
  const [search, setSearch] = useState('');
  const [clientId, setClientId] = useState('');
  const clients = useQuery({
    queryKey: ['worker-clients', search],
    queryFn: () => api<{ clients: { id: string; name: string; status: string; mode: Mode }[] }>(`/console/worker/clients?search=${encodeURIComponent(search)}&limit=200`),
  });
  const detail = useQuery({
    queryKey: ['worker-client', clientId], enabled: !!clientId,
    queryFn: () => api<Detail>(`/console/worker/clients/${clientId}`), refetchInterval: 10_000,
  });
  return <div className="mx-auto grid max-w-7xl gap-5">
    <div><h1 className="text-xl font-semibold">Control del worker</h1>
      <p className="text-sm text-muted-foreground">Uso interno: ejecutivo y tesorero con 2FA. Una política por cliente para sus billeteras y redes habilitadas. Todos los horarios son UTC.</p></div>
    <div className="grid gap-3 sm:grid-cols-2">
      <Field label="Buscar cliente" htmlFor="worker-search"><Input id="worker-search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Nombre o ID" /></Field>
      <Field label="Cliente" htmlFor="worker-client">
        <Select id="worker-client" value={clientId} onChange={(e) => setClientId(e.target.value)}>
          <option value="">Seleccione un cliente</option>
          {clientId && !clients.data?.clients.some((c) => c.id === clientId) && <option value={clientId}>{detail.data?.client.name ?? clientId}</option>}
          {clients.data?.clients.map((c) => <option key={c.id} value={c.id}>{c.name} · {c.status} · {labels[c.mode]}</option>)}
        </Select>
      </Field>
    </div>
    <p className="text-xs text-muted-foreground">Se muestran hasta 200 coincidencias; use la búsqueda para localizar otro cliente.</p>
    <ErrorBox error={clients.error ?? detail.error} />
    {detail.isFetching && !detail.data && clientId && <p>Cargando política…</p>}
    {detail.data && <WorkerClient key={detail.data.client.id} data={detail.data} />}
  </div>;
}

function WorkerClient({ data }: { data: Detail }) {
  const { operator } = useAuth();
  const qc = useQueryClient();
  const [mode, setMode] = useState<Mode>(data.policy.mode);
  const [interval, setInterval] = useState(String(data.policy.interval_minutes));
  const [windows, setWindows] = useState<Window[]>(data.policy.windows);
  const [code, setCode] = useState('');
  const requestId = useRef(crypto.randomUUID());
  const revision = useRef(data.policy.revision);
  useEffect(() => {
    if (revision.current === data.policy.revision) return;
    revision.current = data.policy.revision;
    setMode(data.policy.mode);
    setInterval(String(data.policy.interval_minutes));
    setWindows(data.policy.windows);
    setCode('');
  }, [data.policy]);
  const base = `/console/worker/clients/${data.client.id}`;
  const refresh = () => {
    setCode('');
    qc.invalidateQueries({ queryKey: ['worker-client', data.client.id] });
    qc.invalidateQueries({ queryKey: ['worker-clients'] });
  };
  const save = useMutation({
    mutationFn: () => api<Detail>(`${base}/policy`, { method: 'PUT', json: {
      policy: { mode, interval_minutes: Number(interval), timezone: 'UTC', windows },
      revision: data.policy.revision, code,
    } }),
    onSuccess: (result) => { qc.setQueryData(['worker-client', data.client.id], result); refresh(); },
    onError: refresh,
  });
  const run = useMutation({
    mutationFn: () => api<Run>(`${base}/run`, { method: 'POST', json: { request_id: requestId.current, code } }),
    onSuccess: () => { requestId.current = crypto.randomUUID(); refresh(); },
    onError: refresh,
  });
  const running = data.runs.some((r) => r.status === 'running');
  const busy = save.isPending || run.isPending || running;
  const validCode = /^\d{6}$/.test(code) && operator?.totp_enabled;
  const invalidWindows = mode === 'scheduled' && (!windows.length || windows.some((w) => !w.days.length || !w.start || w.end <= w.start));
  const disabled = !data.worker_enabled || data.setup_required || data.client.status !== 'active';
  const patchWindow = (index: number, patch: Partial<Window>) => setWindows((ws) => ws.map((w, i) => i === index ? { ...w, ...patch } : w));

  return <>
    <Card>
      <CardHeader><CardTitle>{data.client.name}</CardTitle></CardHeader>
      <CardContent className="grid gap-4">
        <div className="grid gap-2 text-sm sm:grid-cols-2">
          <p>Modo vigente: <b>{labels[data.policy.mode]}</b></p>
          <p>Estado: <b>{running ? 'En curso' : 'Sin ejecución en curso'}</b></p>
          <p>Última ejecución: {utc(data.runs[0]?.started_at)}</p>
          <p>Próxima ejecución: {utc(data.policy.next_due_at)}</p>
        </div>
        {disabled && <p role="alert" className="text-sm text-destructive">Disparos bloqueados: {!data.worker_enabled ? 'worker deshabilitado globalmente' : data.setup_required ? 'modo de alta' : 'cliente no activo'}. La fecha prevista no garantiza ejecución mientras exista el bloqueo.</p>}
        {!operator?.totp_enabled && <p role="alert" className="text-sm text-destructive">Active 2FA en Seguridad para configurar o ejecutar.</p>}
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Modo" htmlFor="worker-mode"><Select id="worker-mode" value={mode} disabled={busy} onChange={(e) => setMode(e.target.value as Mode)}>
            {Object.entries(labels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </Select></Field>
          <Field label="Zona horaria" htmlFor="worker-timezone"><Input id="worker-timezone" value="UTC" readOnly /></Field>
          {mode === 'automatic' && <Field label="Intervalo real del worker (minutos)" htmlFor="worker-interval">
            <Input id="worker-interval" type="number" min={5} max={525600} step={1} value={interval} disabled={busy} onChange={(e) => setInterval(e.target.value)} />
          </Field>}
        </div>
        <p className="text-sm text-muted-foreground">
          Manual no genera disparos programados. Automático inicia con 1440 minutos (24 h) por defecto.
          Programado inicia una vez dentro de cada ventana UTC; no recupera ventanas vencidas.
          El botón Ejecutar usa el modo vigente y no cambia la política.
        </p>
        {mode === 'scheduled' && <div className="grid gap-3">
          {windows.map((w, index) => <div key={index} className="grid gap-3 rounded border p-3">
            <div className="flex flex-wrap gap-3">{days.map((label, day) => <label key={day} className="text-sm">
              <input type="checkbox" checked={w.days.includes(day)} disabled={busy} onChange={(e) => patchWindow(index, {
                days: e.target.checked ? [...w.days, day].sort() : w.days.filter((d) => d !== day),
              })} /> {label}
            </label>)}</div>
            <div className="flex flex-wrap items-end gap-3">
              <Field label="Inicio UTC" htmlFor={`worker-start-${index}`}><Input id={`worker-start-${index}`} type="time" value={w.start} disabled={busy} onChange={(e) => patchWindow(index, { start: e.target.value })} /></Field>
              <Field label="Fin UTC (exclusivo)" htmlFor={`worker-end-${index}`}><Input id={`worker-end-${index}`} placeholder="HH:mm (hasta 24:00)" maxLength={5} value={w.end} disabled={busy} onChange={(e) => patchWindow(index, { end: e.target.value })} /></Field>
              <Button variant="outline" disabled={busy} onClick={() => setWindows((ws) => ws.filter((_, i) => i !== index))}>Quitar ventana</Button>
            </div>
          </div>)}
          <Button variant="outline" disabled={busy || windows.length >= 28} onClick={() => setWindows((ws) => [...ws, { days: [1, 2, 3, 4, 5], start: '09:00', end: '10:00' }])}>Agregar ventana</Button>
          <p className="text-xs text-muted-foreground">Para un horario puntual use una ventana corta. Fin 24:00 significa medianoche. No se permiten cruces de medianoche ni ventanas superpuestas.</p>
        </div>}
        <Field label="Código 2FA de un solo uso" htmlFor="worker-code"><Input id="worker-code" inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={code} disabled={busy} onChange={(e) => setCode(e.target.value)} /></Field>
        <ErrorBox error={save.error ?? run.error} />
        <div className="flex flex-wrap gap-3">
          <Button disabled={busy || !validCode || invalidWindows || !Number.isInteger(Number(interval)) || Number(interval) < 5 || Number(interval) > 525600} onClick={() => save.mutate()}>
            {save.isPending ? 'Guardando…' : 'Guardar política'}
          </Button>
          <Button variant="outline" disabled={busy || !validCode || disabled} onClick={() => run.mutate()}>
            {run.isPending ? 'Ejecutando…' : 'Ejecutar este cliente'}
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">La pantalla se consulta cada 10 s; eso no es la frecuencia del worker. Las operaciones firmadas/enviadas y las conciliaciones críticas continúan independientemente del modo.</p>
      </CardContent>
    </Card>
    <Card><CardHeader><CardTitle>Ejecuciones y uso</CardTitle></CardHeader><CardContent>
      <p className="mb-3 text-sm">Intentos iniciados este mes: {data.usage.reduce((sum, u) => sum + Number(u.qty), 0)}. Sin cargos ni tarifas; incluye errores e interrupciones.</p>
      <Table><TableHeader><TableRow><TableHead>Inicio UTC</TableHead><TableHead>Fin UTC</TableHead><TableHead>Disparo</TableHead><TableHead>Resultado</TableHead><TableHead>Detalle por red / error</TableHead></TableRow></TableHeader>
        <TableBody>{data.runs.map((r) => <TableRow key={r.id}>
          <TableCell>{utc(r.started_at)}</TableCell><TableCell>{utc(r.finished_at)}</TableCell><TableCell>{labels[r.trigger]}</TableCell><TableCell>{r.status}</TableCell>
          <TableCell><p className="text-destructive">{r.error}</p>
            {Object.entries(r.networks).map(([network, phases]) => <div key={network}>{network}: {Object.entries(phases).map(([phase, result]) => `${phase}: ${result}`).join(' · ')}</div>)}
          </TableCell>
        </TableRow>)}</TableBody>
      </Table>
      {!data.runs.length && <p className="py-3 text-sm text-muted-foreground">Sin ejecuciones. Los clientes sin política usan Manual.</p>}
      <p className="mt-3 text-xs text-muted-foreground">Últimas 30 ejecuciones. El historial completo permanece en auditoría y base de datos.</p>
    </CardContent></Card>
  </>;
}
