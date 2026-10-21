import { useEffect, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Loader2, Pencil, Plus } from 'lucide-react';
import { api, type UsageOverview, type UsageProvider } from '@/lib/api';
import { ErrorBox, Field, fmtDate } from '@/components/common';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';

const nf = new Intl.NumberFormat('es-MX', { maximumFractionDigits: 2 });
const STATUS = {
  ok: { text: 'Dentro del tope', variant: 'success' },
  warn: { text: 'Cerca del tope', variant: 'warning' },
  over: { text: 'Tope superado', variant: 'destructive' },
  none: { text: 'Sin tope', variant: 'outline' },
} as const;

const gasHuman = (raw: string, decimals: number) => {
  const s = raw.padStart(decimals + 1, '0');
  const i = s.slice(0, -decimals) || '0', f = s.slice(-decimals).slice(0, 6).replace(/0+$/, '');
  return f ? `${i}.${f}` : i;
};

export function Usage() {
  const q = useQuery({ queryKey: ['usage'], queryFn: () => api<UsageOverview>('/usage'), refetchInterval: 60_000 });
  const [edit, setEdit] = useState<UsageProvider | 'new' | null>(null);
  const d = q.data;
  const gasTotalNote = d && d.gas.by_asset.length > 0;

  return (
    <div className="mx-auto grid max-w-7xl grid-cols-[minmax(0,1fr)] gap-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Consumos y topes</h1>
          <p className="text-sm text-muted-foreground">Lo que gastamos por uso (servidor, dominio, DNS, Circle, Alchemy…) contra un tope mensual, para evitar sorpresas en la factura. Solo tesorería.</p>
        </div>
        <Button variant="outline" onClick={() => setEdit('new')}><Plus />Agregar proveedor</Button>
      </div>
      <ErrorBox error={q.error} />

      {d && d.alerts > 0 && (
        <div className="flex items-center gap-2 rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-sm" role="alert">
          <AlertTriangle className="size-4" />{d.alerts} {d.alerts === 1 ? 'proveedor llegó' : 'proveedores llegaron'} al umbral de alerta este mes.
        </div>
      )}

      <Card className="py-2"><CardContent className="px-3">
        <Table>
          <TableHeader><TableRow>
            <TableHead>Proveedor</TableHead><TableHead className="text-right">Consumo del mes</TableHead><TableHead className="text-right">Tope mensual</TableHead>
            <TableHead className="text-right">Avance</TableHead><TableHead className="text-right">Proyección</TableHead><TableHead>Estado</TableHead><TableHead />
          </TableRow></TableHeader>
          <TableBody>
            {q.isPending && <TableRow><TableCell colSpan={7}><Skeleton className="h-6" /></TableCell></TableRow>}
            {d?.providers.map((p) => {
              const s = STATUS[p.status];
              const over = p.projected != null && p.monthly_limit != null && p.projected >= p.monthly_limit && p.status !== 'over';
              return (
                <TableRow key={p.provider} data-provider={p.provider}>
                  <TableCell>
                    <div className="text-sm font-medium">{p.label}</div>
                    <div className="text-xs text-muted-foreground">
                      {p.source === 'metered' ? 'Medido automáticamente' : p.manual_updated_at ? `Capturado ${fmtDate(p.manual_updated_at)} por ${p.manual_updated_by}` : 'Captura manual: sin dato aún'}
                    </div>
                  </TableCell>
                  <TableCell className="num text-right">{nf.format(p.used)} <span className="text-xs text-muted-foreground">{p.unit}</span></TableCell>
                  <TableCell className="num text-right">{p.monthly_limit != null ? nf.format(p.monthly_limit) : '—'}</TableCell>
                  <TableCell className="num text-right">{p.pct != null ? `${nf.format(p.pct)} %` : '—'}</TableCell>
                  <TableCell className="num text-right">
                    {p.projected != null ? <span className={over ? 'font-medium text-warning' : undefined} title={over ? 'A este ritmo superará el tope' : undefined}>{nf.format(p.projected)}</span> : '—'}
                  </TableCell>
                  <TableCell><Badge variant={s.variant}>{s.text}</Badge></TableCell>
                  <TableCell className="text-right"><Button size="sm" variant="ghost" onClick={() => setEdit(p)} aria-label={`Editar ${p.label}`}><Pencil />Editar</Button></TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
        {d?.providers.filter((p) => p.breakdown.length > 0).map((p) => (
          <div key={p.provider} className="border-t px-3 py-3">
            <div className="mb-1 text-xs font-medium text-muted-foreground">{p.label}: detalle del mes</div>
            <div className="flex flex-wrap gap-2">
              {p.breakdown.map((b) => <Badge key={b.metric} variant="secondary"><span className="font-mono">{b.metric}</span> {nf.format(b.qty)}</Badge>)}
            </div>
          </div>
        ))}
      </CardContent></Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Gas que paga la plataforma (este mes)</CardTitle>
          <CardDescription>Base para decidir si conviene un gas patrocinado (por ejemplo Gas Manager de Alchemy con cuentas inteligentes, que cobra un recargo sobre el gas patrocinado).</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-2 text-sm">
          {!gasTotalNote && <p className="text-muted-foreground">Sin gas registrado este mes.</p>}
          {d?.gas.by_asset.map((g) => {
            const total = gasHuman(g.spent, g.decimals);
            const withFee = gasHuman((BigInt(g.spent) * 108n / 100n).toString(), g.decimals);
            return (
              <div key={g.asset_id} className="flex flex-wrap items-center justify-between gap-2 rounded-md border px-3 py-2">
                <span className="font-medium">{g.symbol} <span className="text-xs text-muted-foreground">({g.asset_id})</span></span>
                <span className="num">{total} {g.symbol} · con recargo de 8 %: <b>{withFee}</b></span>
              </div>
            );
          })}
          <p className="text-xs text-muted-foreground">
            Barridos del mes: {Object.entries(d?.gas.sweeps ?? {}).map(([k, n]) => `${k}: ${n}`).join(' · ') || '—'}. Cada <span className="font-mono">gas_topup</span> es una transacción extra que un gas patrocinado evitaría.
          </p>
        </CardContent>
      </Card>

      <BudgetDialog target={edit} onClose={() => setEdit(null)} />
    </div>
  );
}

function BudgetDialog({ target, onClose }: { target: UsageProvider | 'new' | null; onClose: () => void }) {
  const qc = useQueryClient();
  const isNew = target === 'new';
  const p = target && target !== 'new' ? target : null;
  const [f, setF] = useState({ provider: '', label: '', unit: 'USD', limit: '', warn: '80', value: '', notes: '' });
  useEffect(() => {
    if (!target) return;
    setF(p
      ? { provider: p.provider, label: p.label, unit: p.unit, limit: p.monthly_limit != null ? String(p.monthly_limit) : '', warn: String(p.warn_pct),
          value: p.source === 'manual' && p.used ? String(p.used) : '', notes: p.notes ?? '' }
      : { provider: '', label: '', unit: 'USD', limit: '', warn: '80', value: '', notes: '' });
    m.reset();
  }, [target]); // eslint-disable-line react-hooks/exhaustive-deps
  const num = (s: string) => (s.trim() === '' ? null : Number(s));
  const m = useMutation({
    mutationFn: () => api(`/usage/${isNew ? f.provider.trim().toLowerCase() : p!.provider}`, { method: 'PUT', json: {
      ...(isNew ? { label: f.label.trim(), unit: f.unit.trim() } : {}),
      monthly_limit: num(f.limit), warn_pct: Number(f.warn),
      ...(isNew || p?.source === 'manual' ? { manual_value: num(f.value) } : {}),
      notes: f.notes.trim() || null,
    } }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['usage'] }); onClose(); },
  });
  const bad = (f.limit !== '' && !(Number(f.limit) > 0)) || !(Number(f.warn) >= 1 && Number(f.warn) <= 100) || (f.value !== '' && !(Number(f.value) >= 0))
    || (isNew && (!/^[a-z0-9_-]{2,40}$/.test(f.provider.trim().toLowerCase()) || f.label.trim().length < 2 || !f.unit.trim()));
  const manual = isNew || p?.source === 'manual';
  return (
    <Dialog open={!!target} onOpenChange={(v) => !v && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{isNew ? 'Agregar proveedor' : `Tope de ${p?.label}`}</DialogTitle>
          <DialogDescription>{manual ? 'Capture lo gastado en el mes y el tope. Recuerde actualizarlo al revisar la factura.' : 'Este consumo se mide automáticamente; defina el tope y el umbral de alerta.'}</DialogDescription>
        </DialogHeader>
        <form className="grid gap-3" onSubmit={(e: FormEvent) => { e.preventDefault(); m.mutate(); }}>
          {isNew && (
            <>
              <Field label="Clave" htmlFor="u-key" hint="Minúsculas, números, - y _"><Input id="u-key" autoFocus value={f.provider} onChange={(e) => setF({ ...f, provider: e.target.value })} /></Field>
              <Field label="Nombre" htmlFor="u-label"><Input id="u-label" value={f.label} onChange={(e) => setF({ ...f, label: e.target.value })} /></Field>
              <Field label="Unidad" htmlFor="u-unit"><Input id="u-unit" value={f.unit} onChange={(e) => setF({ ...f, unit: e.target.value })} /></Field>
            </>
          )}
          {manual && <Field label={`Gastado este mes (${f.unit})`} htmlFor="u-val"><Input id="u-val" inputMode="decimal" value={f.value} onChange={(e) => setF({ ...f, value: e.target.value })} /></Field>}
          <div className="grid grid-cols-2 gap-3">
            <Field label={`Tope mensual (${f.unit})`} htmlFor="u-limit" hint="Vacío = sin tope"><Input id="u-limit" inputMode="decimal" value={f.limit} onChange={(e) => setF({ ...f, limit: e.target.value })} /></Field>
            <Field label="Alertar al (%)" htmlFor="u-warn"><Input id="u-warn" inputMode="numeric" value={f.warn} onChange={(e) => setF({ ...f, warn: e.target.value })} /></Field>
          </div>
          <Field label="Notas" htmlFor="u-notes"><Input id="u-notes" maxLength={500} value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} /></Field>
          <ErrorBox error={m.error} />
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>Cancelar</Button>
            <Button type="submit" disabled={bad || m.isPending}>{m.isPending && <Loader2 className="animate-spin" />}Guardar</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
