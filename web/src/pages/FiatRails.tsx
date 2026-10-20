// Consola — Control de Rieles Fiat: interruptores, cuentas (propuesta + doble aprobación) y asignación a clientes.
// Todo cambio pide 2FA y motivo; la cuenta completa nunca vuelve del servidor (solo últimos 4 y campos cambiados).
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Landmark, Loader2, Power, Users } from 'lucide-react';
import { api, type ClientRow } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { ErrorBox, Field, fmtDate } from '@/components/common';
import { StepUpDialog } from '@/components/StepUpDialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';

interface Proposal { version: number; last4: string; changed_fields: string[]; created_by: string; created_at: string; reason: string }
interface Rail {
  rail_id: string; label: string; currency: string; country: string | null; rail_type: string; kind: 'manual' | 'automatic';
  priority: number; is_enabled: boolean; visibility: 'all' | 'restricted'; maintenance_message: string | null;
  min_amount: string | null; max_amount: string | null; recommended_for: string | null; settlement_time: string | null;
  account: { version: number; last4: string; approved_by: string | null } | null; pending_proposal: Proposal | null;
}
interface RailsResp { key_configured: boolean; rails: Rail[] }
interface RailClients { rail_id: string; visibility: string; clients: { client_id: string; client_name: string; counterparty_code: string; assigned_by: string; created_at: string }[] }

const FIELDS: Record<string, { key: string; label: string; required?: boolean }[]> = {
  wire: [{ key: 'beneficiary_name', label: 'Beneficiario', required: true }, { key: 'bank_name', label: 'Banco', required: true }, { key: 'account_number', label: 'Cuenta', required: true },
    { key: 'aba', label: 'ABA (9 dígitos)', required: true }, { key: 'swift', label: 'SWIFT/BIC', required: true }, { key: 'intermediary_bank', label: 'Banco intermediario' },
    { key: 'intermediary_swift', label: 'SWIFT intermediario' }, { key: 'bank_address', label: 'Dirección del banco' }],
  ach: [{ key: 'beneficiary_name', label: 'Beneficiario', required: true }, { key: 'bank_name', label: 'Banco', required: true }, { key: 'account_number', label: 'Cuenta', required: true }, { key: 'aba', label: 'ABA (9 dígitos)', required: true }],
  sepa: [{ key: 'beneficiary_name', label: 'Beneficiario', required: true }, { key: 'iban', label: 'IBAN', required: true }, { key: 'bic', label: 'BIC', required: true }, { key: 'bank_name', label: 'Banco' }],
  spei: [{ key: 'beneficiary_name', label: 'Beneficiario', required: true }, { key: 'clabe', label: 'CLABE (18 dígitos)', required: true }, { key: 'bank_name', label: 'Banco' }],
  pix: [{ key: 'beneficiary_name', label: 'Beneficiario', required: true }, { key: 'pix_key', label: 'Llave PIX', required: true }],
  generic: [{ key: 'beneficiary_name', label: 'Beneficiario', required: true }, { key: 'bank_name', label: 'Banco' }, { key: 'account_number', label: 'Cuenta' }, { key: 'details', label: 'Detalles' }],
};
const fieldsFor = (t: string) => FIELDS[t === 'otc' ? 'generic' : t] ?? FIELDS.generic;
const ok = (reason: string) => reason.trim().length >= 5;
const ReasonField = ({ id, value, onChange }: { id: string; value: string; onChange: (v: string) => void }) => (
  <Field label="Motivo" htmlFor={id} hint="Mín. 5 caracteres; queda en la bitácora."><Input id={id} value={value} onChange={(e) => onChange(e.target.value)} maxLength={500} /></Field>
);

export function FiatRails() {
  const { can, operator } = useAuth();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['fiat-rails'], queryFn: () => api<RailsResp>('/console/fiat/rails') });
  const refresh = () => { qc.invalidateQueries({ queryKey: ['fiat-rails'] }); };
  const [toggle, setToggle] = useState<Rail | null>(null);
  const [edit, setEdit] = useState<Rail | null>(null);
  const [decide, setDecide] = useState<{ rail: Rail; approve: boolean } | null>(null);
  const [clientsOf, setClientsOf] = useState<Rail | null>(null);
  const [visibility, setVisibility] = useState<{ rail: Rail; to: 'all' | 'restricted' } | null>(null);
  const tes = can('tesorero');
  const data = q.data;
  return (
    <div className="grid gap-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Control de Rieles Fiat</h1>
        <p className="text-sm text-muted-foreground">Encienda o apague cada riel, cargue sus cuentas (propone un tesorero y aprueba otro) y elija a qué clientes se muestra. Los cambios aplican de inmediato en el portal.</p>
      </div>
      <ErrorBox error={q.error} />
      {data && !data.key_configured && <div role="alert" className="rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-sm">FIAT_RAILS_ENC_KEY no está configurada: no se pueden cargar cuentas y los rieles manuales no pueden encenderse.</div>}
      <Card className="py-2"><CardContent className="px-3">
        {q.isPending ? <Skeleton className="h-40" /> : (
          <div className="overflow-x-auto">
            <Table aria-label="Rieles fiat">
              <TableHeader><TableRow><TableHead>Riel</TableHead><TableHead>Moneda</TableHead><TableHead>Tipo</TableHead><TableHead>Cuenta</TableHead><TableHead>Visibilidad</TableHead><TableHead>Estado</TableHead><TableHead /></TableRow></TableHeader>
              <TableBody>
                {data?.rails.map((r) => (
                  <TableRow key={r.rail_id} data-rail={r.rail_id}>
                    <TableCell><div className="font-medium">{r.label}</div><code className="text-xs text-muted-foreground">{r.rail_id}</code></TableCell>
                    <TableCell>{r.currency}</TableCell>
                    <TableCell className="text-xs">{r.rail_type.toUpperCase()} · {r.kind === 'manual' ? 'manual' : 'automático'}</TableCell>
                    <TableCell className="text-sm">
                      {r.kind === 'automatic' ? '—' : r.account ? <>•••• {r.account.last4} <span className="text-xs text-muted-foreground">v{r.account.version}</span></> : <span className="text-muted-foreground">Sin cuenta</span>}
                      {r.pending_proposal && <div><Badge variant="warning">Propuesta v{r.pending_proposal.version} pendiente</Badge></div>}
                    </TableCell>
                    <TableCell>
                      {tes ? (
                        <Select aria-label={`Visibilidad de ${r.rail_id}`} value={r.visibility} onChange={(e) => setVisibility({ rail: r, to: e.target.value as 'all' | 'restricted' })}>
                          <option value="all">Todos los clientes</option><option value="restricted">Solo asignados</option>
                        </Select>
                      ) : r.visibility === 'all' ? 'Todos' : 'Solo asignados'}
                      {r.visibility === 'restricted' && <Button size="sm" variant="ghost" onClick={() => setClientsOf(r)}><Users />Clientes</Button>}
                    </TableCell>
                    <TableCell>
                      <Button size="sm" variant={r.is_enabled ? 'default' : 'outline'} role="switch" aria-checked={r.is_enabled} aria-label={`Riel ${r.rail_id}`}
                        disabled={!tes} onClick={() => setToggle(r)}><Power />{r.is_enabled ? 'Encendido' : 'Apagado'}</Button>
                    </TableCell>
                    <TableCell className="text-right">
                      {tes && r.kind === 'manual' && <Button size="sm" variant="outline" onClick={() => setEdit(r)}><Landmark />{r.account ? 'Editar cuenta' : 'Cargar cuenta'}</Button>}
                      {tes && r.pending_proposal && (
                        <div className="mt-1 flex justify-end gap-1">
                          {r.pending_proposal.created_by === operator?.email
                            ? <span className="text-xs text-muted-foreground">Debe aprobarla otro tesorero</span>
                            : <><Button size="sm" onClick={() => setDecide({ rail: r, approve: true })}>Aprobar</Button><Button size="sm" variant="outline" onClick={() => setDecide({ rail: r, approve: false })}>Rechazar</Button></>}
                        </div>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent></Card>
      {data && data.rails.some((r) => r.pending_proposal) && (
        <Card><CardContent className="grid gap-2 py-4 text-sm">
          <h2 className="font-semibold">Bandeja de aprobación</h2>
          {data.rails.filter((r) => r.pending_proposal).map((r) => (
            <div key={r.rail_id} className="rounded-md border p-2" data-proposal={r.rail_id}>
              <strong>{r.label}</strong> · v{r.pending_proposal!.version} · •••• {r.pending_proposal!.last4} · propone {r.pending_proposal!.created_by} · {fmtDate(r.pending_proposal!.created_at)}
              <div className="text-xs text-muted-foreground">Campos cambiados: {r.pending_proposal!.changed_fields.join(', ')} — {r.pending_proposal!.reason}</div>
            </div>
          ))}
        </CardContent></Card>
      )}
      <ToggleDialog rail={toggle} onClose={() => setToggle(null)} onDone={refresh} />
      <VisibilityDialog state={visibility} onClose={() => setVisibility(null)} onDone={refresh} />
      <AccountDialog rail={edit} onClose={() => setEdit(null)} onDone={refresh} />
      <DecisionDialog state={decide} onClose={() => setDecide(null)} onDone={refresh} />
      <ClientsDialog rail={clientsOf} onClose={() => setClientsOf(null)} />
    </div>
  );
}

function ToggleDialog({ rail, onClose, onDone }: { rail: Rail | null; onClose: () => void; onDone: () => void }) {
  const [reason, setReason] = useState('');
  const [msg, setMsg] = useState('');
  const turningOn = rail ? !rail.is_enabled : false;
  return (
    <StepUpDialog open={!!rail} title={turningOn ? 'Encender riel' : 'Apagar riel'} confirmLabel={turningOn ? 'Encender' : 'Apagar'} destructive={!turningOn} canSubmit={ok(reason)}
      description={rail && <>{turningOn ? 'El riel se mostrará de inmediato a los clientes habilitados.' : 'El riel dejará de mostrarse y no se podrán crear avisos nuevos; los ya abiertos siguen vigentes.'} <strong>{rail.label}</strong></>}
      onConfirm={(code) => api(`/console/fiat/rails/${rail!.rail_id}`, { method: 'PUT', json: { code, reason: reason.trim(), is_enabled: turningOn, ...(!turningOn && msg.trim() ? { maintenance_message: msg.trim() } : turningOn ? { maintenance_message: null } : {}) } }).then(onDone)}
      onClose={() => { setReason(''); setMsg(''); onClose(); }}>
      <ReasonField id="rail-reason" value={reason} onChange={setReason} />
      {!turningOn && <Field label="Mensaje de mantenimiento (opcional)" htmlFor="rail-msg" hint="Lo ve el cliente en lugar del riel."><Input id="rail-msg" value={msg} onChange={(e) => setMsg(e.target.value)} maxLength={300} /></Field>}
    </StepUpDialog>
  );
}

function VisibilityDialog({ state, onClose, onDone }: { state: { rail: Rail; to: 'all' | 'restricted' } | null; onClose: () => void; onDone: () => void }) {
  const [reason, setReason] = useState('');
  return (
    <StepUpDialog open={!!state && state.to !== state.rail.visibility} title="Cambiar visibilidad del riel" confirmLabel="Cambiar" canSubmit={ok(reason)}
      description={state && (state.to === 'restricted' ? 'Solo los clientes asignados verán y podrán usar el riel (si no asigna ninguno, nadie lo verá).' : 'Todos los clientes verán el riel cuando esté encendido.')}
      onConfirm={(code) => api(`/console/fiat/rails/${state!.rail.rail_id}`, { method: 'PUT', json: { code, reason: reason.trim(), visibility: state!.to } }).then(onDone)}
      onClose={() => { setReason(''); onClose(); }}>
      <ReasonField id="vis-reason" value={reason} onChange={setReason} />
    </StepUpDialog>
  );
}

function AccountDialog({ rail, onClose, onDone }: { rail: Rail | null; onClose: () => void; onDone: () => void }) {
  const [vals, setVals] = useState<Record<string, string>>({});
  const [reason, setReason] = useState('');
  const fields = rail ? fieldsFor(rail.rail_type) : [];
  const valid = ok(reason) && fields.every((f) => !f.required || (vals[f.key] ?? '').trim());
  return (
    <StepUpDialog open={!!rail} title={rail?.account ? 'Proponer cambio de cuenta' : 'Proponer cuenta'} confirmLabel="Enviar propuesta" canSubmit={valid}
      description="Propone una versión nueva (cifrada). Debe aprobarla otro tesorero con 2FA; hasta entonces la cuenta vigente no cambia. Escriba la cuenta completa."
      onConfirm={(code) => api(`/console/fiat/rails/${rail!.rail_id}/accounts`, { method: 'POST', json: { code, reason: reason.trim(),
        account: Object.fromEntries(fields.map((f) => [f.key, (vals[f.key] ?? '').trim()]).filter(([, v]) => v)) } }).then(onDone)}
      onClose={() => { setVals({}); setReason(''); onClose(); }}>
      <div className="grid gap-3">
        {fields.map((f) => (
          <Field key={f.key} label={f.label + (f.required ? ' *' : '')} htmlFor={`acc-${f.key}`}>
            <Input id={`acc-${f.key}`} autoComplete="off" value={vals[f.key] ?? ''} onChange={(e) => setVals({ ...vals, [f.key]: e.target.value })} maxLength={500} /></Field>
        ))}
        <ReasonField id="acc-reason" value={reason} onChange={setReason} />
      </div>
    </StepUpDialog>
  );
}

function DecisionDialog({ state, onClose, onDone }: { state: { rail: Rail; approve: boolean } | null; onClose: () => void; onDone: () => void }) {
  const [reason, setReason] = useState('');
  const p = state?.rail.pending_proposal;
  return (
    <StepUpDialog open={!!state && !!p} title={state?.approve ? 'Aprobar cuenta' : 'Rechazar propuesta'} confirmLabel={state?.approve ? 'Aprobar' : 'Rechazar'} destructive={!state?.approve} canSubmit={ok(reason)}
      description={state && p && <>{state.rail.label}: versión {p.version}, •••• {p.last4}. Campos cambiados: {p.changed_fields.join(', ')}.</>}
      onConfirm={(code) => api(`/console/fiat/rails/${state!.rail.rail_id}/accounts/${p!.version}/${state!.approve ? 'approve' : 'reject'}`, { method: 'POST', json: { code, reason: reason.trim() } }).then(onDone)}
      onClose={() => { setReason(''); onClose(); }}>
      <ReasonField id="dec-reason" value={reason} onChange={setReason} />
    </StepUpDialog>
  );
}

function ClientsDialog({ rail, onClose }: { rail: Rail | null; onClose: () => void }) {
  const { can } = useAuth();
  const qc = useQueryClient();
  const [search, setSearch] = useState('');
  const [pick, setPick] = useState('');
  const [act, setAct] = useState<{ client_id: string; assign: boolean; name: string } | null>(null);
  const [reason, setReason] = useState('');
  const list = useQuery({ queryKey: ['fiat-rail-clients', rail?.rail_id], enabled: !!rail, queryFn: () => api<RailClients>(`/console/fiat/rails/${rail!.rail_id}/clients`) });
  const found = useQuery({
    queryKey: ['fiat-rail-client-search', search], enabled: !!rail && can('tesorero'),
    queryFn: () => api<{ clients: ClientRow[] }>(`/clients?status=active&limit=20${search.trim() ? `&q=${encodeURIComponent(search.trim())}` : ''}`).then((r) => r.clients),
  });
  const done = () => { qc.invalidateQueries({ queryKey: ['fiat-rail-clients', rail?.rail_id] }); setReason(''); setPick(''); };
  const chosen = found.data?.find((c) => c.id === pick);
  return (
    <>
      <Dialog open={!!rail && !act} onOpenChange={(v) => !v && onClose()}>
        <DialogContent>
          <DialogHeader><DialogTitle>Clientes con acceso a {rail?.label}</DialogTitle><DialogDescription>Solo estos clientes verán y podrán usar el riel mientras su visibilidad sea «Solo asignados».</DialogDescription></DialogHeader>
          <ErrorBox error={list.error} />
          <ul className="grid gap-1 text-sm" aria-label="Clientes asignados">
            {!list.data?.clients.length && <li className="text-muted-foreground">Ningún cliente asignado.</li>}
            {list.data?.clients.map((c) => (
              <li key={c.client_id} className="flex items-center justify-between gap-2 rounded border px-2 py-1" data-assigned={c.client_id}>
                <span>{c.client_name} <code className="text-xs text-muted-foreground">{c.counterparty_code}</code></span>
                {can('tesorero') && <Button size="sm" variant="ghost" className="text-destructive" onClick={() => setAct({ client_id: c.client_id, assign: false, name: c.client_name })}>Quitar</Button>}
              </li>
            ))}
          </ul>
          {can('tesorero') && (
            <div className="grid gap-2">
              <Input aria-label="Buscar cliente" placeholder="Buscar cliente…" value={search} onChange={(e) => setSearch(e.target.value)} />
              <Select aria-label="Cliente a asignar" value={pick} onChange={(e) => setPick(e.target.value)}>
                <option value="">Elija…</option>{(found.data ?? []).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </Select>
              <Button disabled={!pick} onClick={() => setAct({ client_id: pick, assign: true, name: chosen?.name ?? '' })}>Agregar</Button>
            </div>
          )}
          <DialogFooter><Button variant="outline" onClick={onClose}>Cerrar</Button></DialogFooter>
        </DialogContent>
      </Dialog>
      <StepUpDialog open={!!act} title={act?.assign ? 'Asignar riel al cliente' : 'Quitar riel al cliente'} confirmLabel={act?.assign ? 'Asignar' : 'Quitar'} destructive={!act?.assign} canSubmit={ok(reason)}
        description={act && <>{act.name} · {rail?.label}</>}
        onConfirm={(code) => act!.assign
          ? api(`/console/fiat/rails/${rail!.rail_id}/clients`, { method: 'POST', json: { code, reason: reason.trim(), client_id: act!.client_id } }).then(done)
          : api(`/console/fiat/rails/${rail!.rail_id}/clients/${act!.client_id}/unassign`, { method: 'POST', json: { code, reason: reason.trim() } }).then(done)}
        onClose={() => setAct(null)}>
        <ReasonField id="cl-reason" value={reason} onChange={setReason} />
      </StepUpDialog>
    </>
  );
}

/** Rieles asignados a un cliente (para el detalle del cliente). */
export function ClientRailsCard({ clientId }: { clientId: string }) {
  const q = useQuery({ queryKey: ['client-fiat-rails', clientId], queryFn: () => api<{ rails: { rail_id: string; label: string; currency: string; is_enabled: boolean; visibility: string; assigned: boolean; effective: boolean }[] }>(`/console/fiat/clients/${clientId}/rails`) });
  return (
    <Card data-testid="client-rails"><CardContent className="grid gap-2 py-4 text-sm">
      <h2 className="flex items-center gap-2 font-semibold">{q.isPending && <Loader2 className="size-3 animate-spin" />}Rieles fiat</h2>
      <ErrorBox error={q.error} />
      {q.data?.rails.filter((r) => r.effective).map((r) => (
        <div key={r.rail_id} className="flex items-center gap-2"><span>{r.label} ({r.currency})</span>
          <Badge variant={r.is_enabled ? 'success' : 'outline'}>{r.is_enabled ? 'Encendido' : 'Apagado'}</Badge>
          <span className="text-xs text-muted-foreground">{r.visibility === 'restricted' ? 'Asignado' : 'Todos los clientes'}</span></div>
      ))}
    </CardContent></Card>
  );
}
