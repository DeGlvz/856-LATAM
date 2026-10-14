import { useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router';
import { useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Loader2, Plus, Search } from 'lucide-react';
import { api, newIdemKey, type ClientDetail, type ClientKind, type ClientRow, type ClientStatus } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { CLIENT_KIND, CLIENT_STATUS, useAssets } from '@/lib/hooks';
import { ErrorBox, Field, StatusBadge, fmtDate } from '@/components/common';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';

function useDebounced<T>(v: T, ms = 300) {
  const [d, setD] = useState(v);
  useEffect(() => { const t = setTimeout(() => setD(v), ms); return () => clearTimeout(t); }, [v, ms]);
  return d;
}

export function Clients() {
  const { can } = useAuth();
  const nav = useNavigate();
  const [q, setQ] = useState('');
  const [status, setStatus] = useState<'' | ClientStatus>('');
  const [kind, setKind] = useState<'' | ClientKind>('');
  const [creating, setCreating] = useState(false);
  const dq = useDebounced(q.trim());

  const list = useInfiniteQuery({
    queryKey: ['clients', { q: dq, status, kind }],
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) => {
      const p = new URLSearchParams({ limit: '50' });
      if (dq) p.set('q', dq);
      if (status) p.set('status', status);
      if (kind) p.set('kind', kind);
      if (pageParam) p.set('cursor', pageParam);
      return api<{ clients: ClientRow[]; next_cursor: string | null }>(`/clients?${p}`);
    },
    getNextPageParam: (last) => last.next_cursor,
  });
  const rows = list.data?.pages.flatMap((p) => p.clients) ?? [];

  return (
    <div className="mx-auto grid max-w-7xl grid-cols-[minmax(0,1fr)] gap-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Clientes</h1>
          <p className="text-sm text-muted-foreground">Fondos, tesorerías y fintechs con cuentas en el libro.</p>
        </div>
        {can('ejecutivo') && <Button onClick={() => setCreating(true)}><Plus />Nuevo cliente</Button>}
      </div>

      <Card className="py-4">
        <CardContent className="grid gap-3 sm:grid-cols-[1fr_180px_180px]">
          <div className="relative">
            <Search className="pointer-events-none absolute top-2.5 left-2.5 size-4 text-muted-foreground" />
            <Input aria-label="Buscar" className="pl-8" placeholder="Nombre, id externo o UUID" value={q} onChange={(e) => setQ(e.target.value)} />
          </div>
          <Select aria-label="Estado" value={status} onChange={(e) => setStatus(e.target.value as ClientStatus | '')}>
            <option value="">Todos los estados</option>
            {Object.entries(CLIENT_STATUS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
          </Select>
          <Select aria-label="Tipo" value={kind} onChange={(e) => setKind(e.target.value as ClientKind | '')}>
            <option value="">Todos los tipos</option>
            {Object.entries(CLIENT_KIND).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </Select>
        </CardContent>
      </Card>

      <ErrorBox error={list.error} />

      <Card className="py-2">
        <CardContent className="px-3">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Cliente</TableHead>
                <TableHead>Id externo</TableHead>
                <TableHead>Tipo</TableHead>
                <TableHead>Estado</TableHead>
                <TableHead className="text-right">Cuentas</TableHead>
                <TableHead className="text-right">Alta</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {list.isPending && [0, 1, 2].map((i) => <TableRow key={i}><TableCell colSpan={6}><Skeleton className="h-6" /></TableCell></TableRow>)}
              {!list.isPending && rows.length === 0 && (
                <TableRow><TableCell colSpan={6} className="py-8 text-center text-muted-foreground">Sin clientes con estos filtros</TableCell></TableRow>
              )}
              {rows.map((c) => (
                <TableRow key={c.id} className="cursor-pointer" onClick={() => nav(`/clientes/${c.id}`)}>
                  <TableCell>
                    <Link to={`/clientes/${c.id}`} className="font-medium hover:underline" onClick={(e) => e.stopPropagation()}>{c.name}</Link>
                    <div className="font-mono text-[11px] text-muted-foreground">{c.id.slice(0, 8)}</div>
                  </TableCell>
                  <TableCell className="font-mono text-xs">{c.external_id ?? '—'}</TableCell>
                  <TableCell>{CLIENT_KIND[c.kind]}</TableCell>
                  <TableCell><StatusBadge status={c.status} /></TableCell>
                  <TableCell className="num text-right">{c.accounts_count}</TableCell>
                  <TableCell className="num text-right text-muted-foreground">{fmtDate(c.created_at)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          {list.hasNextPage && (
            <div className="flex justify-center py-3">
              <Button variant="outline" size="sm" onClick={() => list.fetchNextPage()} disabled={list.isFetchingNextPage}>
                {list.isFetchingNextPage && <Loader2 className="animate-spin" />}Cargar más
              </Button>
            </div>
          )}
        </CardContent>
      </Card>

      <NewClientDialog open={creating} onOpenChange={setCreating} onCreated={(id) => nav(`/clientes/${id}`)} />
    </div>
  );
}

function NewClientDialog({ open, onOpenChange, onCreated }: { open: boolean; onOpenChange: (v: boolean) => void; onCreated: (id: string) => void }) {
  const qc = useQueryClient();
  const { assets } = useAssets();
  const [name, setName] = useState('');
  const [externalId, setExternalId] = useState('');
  const [kind, setKind] = useState<ClientKind>('corporate');
  const [selected, setSelected] = useState<string[]>([]);
  const [key, setKey] = useState(newIdemKey);

  useEffect(() => { if (open) { setName(''); setExternalId(''); setKind('corporate'); setSelected([]); setKey(newIdemKey()); } }, [open]);

  const m = useMutation({
    mutationFn: () => api<ClientDetail>('/clients', {
      method: 'POST', headers: { 'idempotency-key': key },
      json: { name: name.trim(), kind, ...(externalId.trim() ? { external_id: externalId.trim() } : {}), assets: selected },
    }),
    onSuccess: (c) => { qc.invalidateQueries({ queryKey: ['clients'] }); qc.invalidateQueries({ queryKey: ['summary'] }); onOpenChange(false); onCreated(c.id); },
  });

  const submit = (e: FormEvent) => { e.preventDefault(); m.mutate(); };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Nuevo cliente</DialogTitle>
          <DialogDescription>Se crea en estado «KYB pendiente». Las cuentas elegidas se abren con saldo cero.</DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="grid gap-4">
          <Field label="Nombre o razón social" htmlFor="nc-name">
            <Input id="nc-name" required minLength={2} maxLength={200} value={name} onChange={(e) => setName(e.target.value)} autoFocus />
          </Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Id externo (ERP)" htmlFor="nc-ext" hint="Opcional, único">
              <Input id="nc-ext" maxLength={100} value={externalId} onChange={(e) => setExternalId(e.target.value)} />
            </Field>
            <Field label="Tipo" htmlFor="nc-kind">
              <Select id="nc-kind" value={kind} onChange={(e) => setKind(e.target.value as ClientKind)}>
                {Object.entries(CLIENT_KIND).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
              </Select>
            </Field>
          </div>
          <fieldset className="grid gap-2">
            <legend className="mb-1 text-sm font-medium">Cuentas a abrir</legend>
            {assets.filter((a) => a.active).map((a) => (
              <label key={a.id} className="flex items-center gap-2 text-sm">
                <input type="checkbox" className="size-4 accent-primary" checked={selected.includes(a.id)}
                  onChange={(e) => setSelected((s) => e.target.checked ? [...s, a.id] : s.filter((x) => x !== a.id))} />
                <span className="font-medium">{a.symbol}</span><span className="font-mono text-xs text-muted-foreground">{a.id}</span>
              </label>
            ))}
          </fieldset>
          <ErrorBox error={m.error} />
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>Cancelar</Button>
            <Button type="submit" disabled={m.isPending || name.trim().length < 2}>{m.isPending && <Loader2 className="animate-spin" />}Crear cliente</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
