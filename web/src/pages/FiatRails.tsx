// Consola — Control de Rieles Fiat: interruptores, cuentas (propuesta + doble aprobación) y asignación a clientes.
// Todo cambio pide 2FA y motivo; la cuenta completa nunca vuelve del servidor (solo últimos 4 y campos cambiados).
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Landmark, Loader2, Power, Users } from 'lucide-react';
import { api, type ClientRow } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { ErrorBox, Field, fmtDate } from '@/components/common';
import { StepUpDialog } from '@/components/StepUpDialog';
import { fieldsFor, SUBTYPES, validate, WIZARD, type Subtype } from '@/lib/railFields';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';

interface Proposal { version: number; last4: string; changed_fields: string[]; created_by: string; created_at: string; reason: string; holder_type: string | null }
interface Rail {
  rail_id: string; label: string; currency: string; country: string | null; rail_type: string; kind: 'manual' | 'automatic';
  priority: number; is_enabled: boolean; visibility: 'all' | 'restricted'; maintenance_message: string | null;
  min_amount: string | null; max_amount: string | null; recommended_for: string | null; settlement_time: string | null;
  fallback_of: string | null; requires_review: boolean; is_archived: boolean;
  account: { version: number; last4: string; approved_by: string | null; holder_type: string | null } | null; pending_proposal: Proposal | null;
}
interface RailsResp { key_configured: boolean; rails: Rail[] }
interface RailClients { rail_id: string; visibility: string; clients: { client_id: string; client_name: string; counterparty_code: string; assigned_by: string; created_at: string }[] }

const PERSONAL_RISK = 'Cuenta personal: puede violar los términos del banco y el nombre del titular se muestra al cliente. Solo se publica a clientes asignados explícitamente (acuerdo implícito con ellos).';
const isPersonal = (r: Rail) => r.account?.holder_type === 'persona';
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
  const [form, setForm] = useState<{ rail: Rail | null } | null>(null);
  const [archive, setArchive] = useState<{ rail: Rail; archive: boolean } | null>(null);
  const [visibility, setVisibility] = useState<{ rail: Rail; to: 'all' | 'restricted' } | null>(null);
  const [del, setDel] = useState<Rail | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const tes = can('tesorero');
  const data = q.data;
  const visibleRails = data?.rails.filter((r) => showArchived || !r.is_archived);
  return (
    <div className="grid gap-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Control de Rieles Fiat</h1>
        <p className="text-sm text-muted-foreground">Encienda o apague cada riel, cargue sus cuentas (propone un tesorero y aprueba otro) y elija a qué clientes se muestra. Los cambios aplican de inmediato en el portal.</p>
      </div>
      <ErrorBox error={q.error} />
      <div className="flex items-center gap-4">
        {tes && <Button onClick={() => setForm({ rail: null })}>Nuevo riel manual</Button>}
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} />Mostrar archivados</label>
      </div>
      {data && !data.key_configured && <div role="alert" className="rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-sm">FIAT_RAILS_ENC_KEY no está configurada: no se pueden cargar cuentas y los rieles manuales no pueden encenderse.</div>}
      <Card className="py-2"><CardContent className="px-3">
        {q.isPending ? <Skeleton className="h-40" /> : (
          <div className="overflow-x-auto">
            <Table aria-label="Rieles fiat">
              <TableHeader><TableRow><TableHead>Riel</TableHead><TableHead>Moneda</TableHead><TableHead>Tipo</TableHead><TableHead>Cuenta</TableHead><TableHead>Visibilidad</TableHead><TableHead>Estado</TableHead><TableHead /></TableRow></TableHeader>
              <TableBody>
                {visibleRails?.map((r) => (
                  <TableRow key={r.rail_id} data-rail={r.rail_id} className={r.is_archived ? 'opacity-50' : undefined}>
                    <TableCell><div className="font-medium">{r.label}{r.is_archived && <> <Badge variant="outline">Archivado</Badge></>}</div><code className="text-xs text-muted-foreground">{r.rail_id}</code></TableCell>
                    <TableCell>{r.currency}</TableCell>
                    <TableCell className="text-xs">{r.rail_type.toUpperCase()} · {r.kind === 'manual' ? 'manual' : 'automático'}</TableCell>
                    <TableCell className="text-sm">
                      {r.kind === 'automatic' ? '—' : r.account ? <>•••• {r.account.last4} <span className="text-xs text-muted-foreground">v{r.account.version}</span></> : <span className="text-muted-foreground">Sin cuenta</span>}
                      {r.pending_proposal && <div><Badge variant="warning">Propuesta v{r.pending_proposal.version} pendiente</Badge></div>}
                    </TableCell>
                    <TableCell>
                      {tes ? (
                        <Select aria-label={`Visibilidad de ${r.rail_id}`} value={isPersonal(r) ? 'restricted' : r.visibility} disabled={isPersonal(r)}
                          onChange={(e) => setVisibility({ rail: r, to: e.target.value as 'all' | 'restricted' })}>
                          <option value="all">Todos los clientes</option><option value="restricted">Solo asignados</option>
                        </Select>
                      ) : r.visibility === 'all' ? 'Todos' : 'Solo asignados'}
                      {isPersonal(r) && <div className="mt-1 text-xs text-warning" data-personal={r.rail_id}>Cuenta personal: visibilidad bloqueada en «Solo asignados».</div>}
                      {(r.visibility === 'restricted' || isPersonal(r)) && <Button size="sm" variant="ghost" onClick={() => setClientsOf(r)}><Users />{isPersonal(r) ? 'Asignar clientes' : 'Clientes'}</Button>}
                    </TableCell>
                    <TableCell>
                      <Button size="sm" variant={r.is_enabled ? 'default' : 'outline'} role="switch" aria-checked={r.is_enabled} aria-label={`Riel ${r.rail_id}`}
                        disabled={!tes} onClick={() => setToggle(r)}><Power />{r.is_enabled ? 'Encendido' : 'Apagado'}</Button>
                    </TableCell>
                    <TableCell className="text-right">
                      {tes && !r.is_archived && <Button size="sm" variant="outline" onClick={() => setForm({ rail: r })}>Editar riel</Button>}{' '}
                      {tes && r.kind === 'manual' && !r.is_archived && <Button size="sm" variant="outline" onClick={() => setEdit(r)}><Landmark />{r.account ? 'Editar cuenta' : 'Cargar cuenta'}</Button>}
                      {tes && r.kind === 'manual' && (r.is_archived
                        ? <><Button size="sm" variant="outline" onClick={() => setArchive({ rail: r, archive: false })}>Restaurar</Button>{' '}<Button size="sm" variant="destructive" onClick={() => setDel(r)}>Eliminar</Button></>
                        : <Button size="sm" variant="ghost" onClick={() => setArchive({ rail: r, archive: true })}>Archivar</Button>)}
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
              {r.pending_proposal!.holder_type === 'persona' && <div role="alert" className="mt-1 text-xs text-warning">{PERSONAL_RISK}{r.visibility !== 'restricted' && ' Antes de aprobar, cambie el riel a «Solo asignados».'}</div>}
            </div>
          ))}
        </CardContent></Card>
      )}
      <ToggleDialog rail={toggle} onClose={() => setToggle(null)} onDone={refresh} />
      <RailFormDialog state={form} onClose={() => setForm(null)} onDone={refresh} />
      <ArchiveDialog state={archive} onClose={() => setArchive(null)} onDone={refresh} />
      <DeleteDialog rail={del} onClose={() => setDel(null)} onDone={refresh} />
      <VisibilityDialog state={visibility} onClose={() => setVisibility(null)} onDone={refresh} />
      <AccountDialog rail={edit} onClose={() => setEdit(null)} onDone={refresh} />
      <DecisionDialog state={decide} onClose={() => setDecide(null)} onDone={refresh} />
      <ClientsDialog rail={clientsOf} onClose={() => setClientsOf(null)} />
    </div>
  );
}

function RailFormDialog({ state, onClose, onDone }: { state: { rail: Rail | null } | null; onClose: () => void; onDone: () => void }) {
  const rail = state?.rail ?? null;
  const locked = rail?.kind === 'automatic';
  const blank = { rail_id: '', label: '', currency: '', country: '', rail_type: 'wire', priority: '100', fallback_of: '', min_amount: '', max_amount: '', recommended_for: '', settlement_time: '', maintenance_message: '', requires_review: true };
  const init = rail ? { rail_id: rail.rail_id, label: rail.label, currency: rail.currency, country: rail.country ?? '', rail_type: rail.rail_type, priority: String(rail.priority), fallback_of: rail.fallback_of ?? '',
    min_amount: rail.min_amount ?? '', max_amount: rail.max_amount ?? '', recommended_for: rail.recommended_for ?? '', settlement_time: rail.settlement_time ?? '', maintenance_message: rail.maintenance_message ?? '', requires_review: rail.requires_review } : blank;
  const [f, setF] = useState<typeof blank | null>(null);
  const [reason, setReason] = useState('');
  const v = f ?? init;
  const set = (k: keyof typeof blank, val: string | boolean) => setF({ ...v, [k]: val });
  const nul = (s: string) => (s.trim() ? s.trim() : null);
  const valid = ok(reason) && (locked || (/^[a-z0-9][a-z0-9_-]{1,39}$/.test(v.rail_id) && v.label.trim().length >= 2 && /^[A-Z]{3}$/.test(v.currency) && (!v.country || /^[A-Z]{2}$/.test(v.country))));
  const body = () => ({
    reason: reason.trim(), min_amount: nul(v.min_amount), max_amount: nul(v.max_amount), maintenance_message: nul(v.maintenance_message),
    ...(locked ? {} : { label: v.label.trim(), currency: v.currency, country: nul(v.country), rail_type: v.rail_type, priority: Number(v.priority) || 0,
      fallback_of: nul(v.fallback_of), recommended_for: nul(v.recommended_for), settlement_time: nul(v.settlement_time), requires_review: v.requires_review }),
  });
  const txt = (k: keyof typeof blank, label: string, extra: { disabled?: boolean; max?: number; hint?: string } = {}) => (
    <Field label={label} htmlFor={`rf-${k}`} hint={extra.hint}><Input id={`rf-${k}`} autoComplete="off" disabled={extra.disabled} maxLength={extra.max ?? 300} value={String(v[k])} onChange={(e) => set(k, e.target.value)} /></Field>
  );
  return (
    <StepUpDialog open={!!state} title={rail ? `Editar riel ${rail.rail_id}` : 'Nuevo riel manual'} confirmLabel={rail ? 'Guardar' : 'Crear riel'} canSubmit={valid}
      description={rail ? (locked ? 'Riel automático: solo se editan mensaje y límites.' : 'Los cambios aplican de inmediato en el portal. No incluye la cuenta bancaria (se propone aparte).') : 'El riel nace apagado y sin cuenta: cargue y apruebe una cuenta antes de encenderlo.'}
      onConfirm={(code) => rail
        ? api(`/console/fiat/rails/${rail.rail_id}`, { method: 'PUT', json: { code, ...body() } }).then(onDone)
        : api('/console/fiat/rails', { method: 'POST', json: { code, rail_id: v.rail_id, ...body() } }).then(onDone)}
      onClose={() => { setF(null); setReason(''); onClose(); }}>
      <div className="grid gap-3">
        {!rail && txt('rail_id', 'Identificador (slug) *', { max: 40, hint: 'Minúsculas, números, guion; único e inmutable.' })}
        {!locked && <>
          {txt('label', 'Nombre *', { max: 100 })}
          <div className="grid grid-cols-2 gap-3">{txt('currency', 'Moneda (ISO) *', { max: 3 })}{txt('country', 'País (ISO)', { max: 2 })}</div>
          <Field label="Tipo de riel" htmlFor="rf-rail_type" hint={rail ? 'No se puede cambiar si ya tiene cuentas.' : undefined}>
            <Select id="rf-rail_type" value={v.rail_type} onChange={(e) => set('rail_type', e.target.value)}>
              {['wire', 'ach', 'sepa', 'spei', 'pix', 'otc', 'generic'].map((t) => <option key={t} value={t}>{t.toUpperCase()}</option>)}</Select></Field>
          <div className="grid grid-cols-2 gap-3">{txt('priority', 'Prioridad')}{txt('fallback_of', 'Alterno de (rail_id)', { max: 40 })}</div>
          {txt('recommended_for', 'Recomendado para')}{txt('settlement_time', 'Tiempo de liquidación')}
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={v.requires_review} onChange={(e) => set('requires_review', e.target.checked)} />Requiere revisión de tesorería</label>
        </>}
        <div className="grid grid-cols-2 gap-3">{txt('min_amount', 'Monto mínimo')}{txt('max_amount', 'Monto máximo')}</div>
        {txt('maintenance_message', 'Mensaje de mantenimiento')}
        <ReasonField id="rf-reason" value={reason} onChange={setReason} />
      </div>
    </StepUpDialog>
  );
}

function DeleteDialog({ rail, onClose, onDone }: { rail: Rail | null; onClose: () => void; onDone: () => void }) {
  const [reason, setReason] = useState('');
  const [confirm, setConfirm] = useState('');
  const close = () => { setReason(''); setConfirm(''); onClose(); };
  return (
    <StepUpDialog open={!!rail} title="Eliminar riel definitivamente" confirmLabel="Eliminar" destructive canSubmit={ok(reason) && confirm === rail?.rail_id}
      description={rail && `${rail.label} se borra de forma permanente junto con sus propuestas pendientes y asignaciones de clientes. Solo es posible si no tiene historial; si lo tiene, solo puede archivarse.`}
      onConfirm={(code) => api(`/console/fiat/rails/${rail!.rail_id}/delete`, { method: 'POST', json: { code, reason: reason.trim(), confirm } }).then(onDone)}
      onClose={close}>
      <ReasonField id="del-reason" value={reason} onChange={setReason} />
      <Field label={`Escriba ${rail?.rail_id ?? ''} para confirmar`} htmlFor="del-confirm"><Input id="del-confirm" value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="off" /></Field>
    </StepUpDialog>
  );
}

function ArchiveDialog({ state, onClose, onDone }: { state: { rail: Rail; archive: boolean } | null; onClose: () => void; onDone: () => void }) {
  const [reason, setReason] = useState('');
  return (
    <StepUpDialog open={!!state} title={state?.archive ? 'Archivar riel' : 'Restaurar riel'} confirmLabel={state?.archive ? 'Archivar' : 'Restaurar'} destructive={!!state?.archive} canSubmit={ok(reason)}
      description={state && (state.archive ? `${state.rail.label} se apagará y dejará de mostrarse; no se borra y su historial se conserva. No se puede si hay avisos de pago abiertos.` : `${state.rail.label} vuelve apagado.`)}
      onConfirm={(code) => api(`/console/fiat/rails/${state!.rail.rail_id}`, { method: 'PUT', json: { code, reason: reason.trim(), is_archived: state!.archive } }).then(onDone)}
      onClose={() => { setReason(''); onClose(); }}>
      <ReasonField id="arc-reason" value={reason} onChange={setReason} />
    </StepUpDialog>
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
  const [subtype, setSubtype] = useState<Subtype>('wire_domestic');
  const [reveal, setReveal] = useState(false);
  const [revealReason, setRevealReason] = useState('');
  const [revealed, setRevealed] = useState(false);
  const editing = !!rail?.account;
  const fields = rail ? fieldsFor(rail.rail_type, subtype) : [];
  const errs = validate(fields, vals, editing);
  const hidden = rail ? fieldsFor(rail.rail_type, subtype === 'wire_intl' ? 'wire_domestic' : 'wire_intl').filter((f) => !fields.some((g) => g.key === f.key)) : [];
  const wizard = rail ? WIZARD.find((w) => w.railType === rail.rail_type && (!w.subtype || w.subtype === subtype)) : undefined;
  const hasChange = fields.some((f) => (vals[f.key] ?? '').trim());
  const valid = ok(reason) && !Object.keys(errs).length && (!editing || hasChange);
  const personal = vals.account_holder_type === 'persona';
  const reset = () => { setVals({}); setReason(''); setSubtype('wire_domestic'); setRevealed(false); setRevealReason(''); };
  // Al editar solo se envían los campos tocados (el servidor hereda el resto); "" borra un opcional
  const payload = () => {
    const out: Record<string, string> = {};
    for (const f of fields) { const v = (vals[f.key] ?? '').trim(); if (v || (editing && revealed)) out[f.key] = v; }
    if (editing) for (const f of hidden) out[f.key] = '';
    return out;
  };
  return (
    <>
      <StepUpDialog open={!!rail && !reveal} title={editing ? 'Proponer cambio de cuenta' : 'Proponer cuenta'} confirmLabel="Enviar propuesta" canSubmit={valid}
        description="Propone una versión nueva (cifrada). Debe aprobarla otro tesorero con 2FA; hasta entonces la cuenta vigente no cambia."
        onConfirm={(code) => api(`/console/fiat/rails/${rail!.rail_id}/accounts`, { method: 'POST', json: { code, reason: reason.trim(), inherit: editing, account: payload() } }).then(onDone)}
        onClose={() => { reset(); onClose(); }}>
        <div className="grid gap-3">
          <div role="note" className="rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-xs">
            Una cuenta personal puede violar los términos del banco, y el titular se muestra al cliente. Prefiera cuentas de empresa.
          </div>
          {rail && (
            <Field label="¿Qué tipo de riel elijo?" htmlFor="acc-wizard" hint="Según el dato que tenga, se preselecciona el tipo y se ocultan los campos que no aplican.">
              <Select id="acc-wizard" value={wizard?.intent ?? ''} onChange={(e) => {
                const w = WIZARD.find((x) => x.intent === e.target.value);
                if (w?.subtype) setSubtype(w.subtype);
              }}>
                <option value="">Elija según el dato que tiene…</option>
                {WIZARD.map((w) => <option key={w.intent} value={w.intent}>{w.label}</option>)}
              </Select>
            </Field>
          )}
          {wizard && wizard.railType !== rail!.rail_type && <p role="alert" className="text-xs text-warning">Este riel es de tipo {rail!.rail_type.toUpperCase()}; use «Editar riel» para cambiar el tipo a {wizard.railType.toUpperCase()} antes de cargar la cuenta.</p>}
          {WIZARD.some((w) => w.railType === rail?.rail_type && w.subtype) && (
            <Field label="Subtipo de wire" htmlFor="acc-subtype" hint="Nacional: ABA/ruta, SWIFT opcional. Internacional: SWIFT/BIC obligatorio, ABA opcional.">
              <Select id="acc-subtype" value={subtype} onChange={(e) => setSubtype(e.target.value as Subtype)}>
                {SUBTYPES.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
              </Select>
            </Field>
          )}
          {editing && (
            <div className="rounded-md border p-2 text-xs">
              Cuenta vigente: •••• {rail!.account!.last4} (v{rail!.account!.version}). Deje en blanco lo que no cambia; solo se envían los campos que escriba.
              {!revealed
                ? <> <Button size="sm" variant="outline" type="button" onClick={() => setReveal(true)}>Revelar cuenta actual (2FA)</Button></>
                : <> Valores actuales cargados; edite lo necesario.</>}
            </div>
          )}
          {fields.map((f) => (
            <Field key={f.key} label={f.label + (f.required ? ' *' : '')} htmlFor={`acc-${f.key}`} hint={`${f.help} Ejemplo: ${f.example}`}>
              {f.select ? (
                <Select id={`acc-${f.key}`} value={vals[f.key] ?? ''} onChange={(e) => setVals({ ...vals, [f.key]: e.target.value })}>
                  {f.select.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                </Select>
              ) : (
                <Input id={`acc-${f.key}`} autoComplete="off" value={vals[f.key] ?? ''} aria-invalid={!!errs[f.key]} placeholder={editing && !revealed ? '(sin cambios)' : undefined}
                  onChange={(e) => setVals({ ...vals, [f.key]: e.target.value })} maxLength={500} />
              )}
              {errs[f.key] && vals[f.key] !== undefined && <p role="alert" className="text-xs text-destructive">{errs[f.key]}</p>}
            </Field>
          ))}
          {personal && (
            <div role="alert" className="rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-xs" data-personal-warning>
              {PERSONAL_RISK} Al enviar acepta el riesgo; el riel quedará forzado a «Solo asignados» y requiere al menos un cliente asignado para encenderse.
            </div>
          )}
          <ReasonField id="acc-reason" value={reason} onChange={setReason} />
        </div>
      </StepUpDialog>
      <StepUpDialog open={reveal} title="Revelar cuenta actual" confirmLabel="Revelar" canSubmit={ok(revealReason)}
        description="Muestra los valores completos de la cuenta vigente para precargar el formulario. Queda en la bitácora (sin valores)."
        onConfirm={(code) => api<{ account: Record<string, string> }>(`/console/fiat/rails/${rail!.rail_id}/account/reveal`, { method: 'POST', json: { code, reason: revealReason.trim() } })
          .then((r) => { setVals(r.account); setRevealed(true); if (r.account.swift && !r.account.aba) setSubtype('wire_intl'); })}
        onClose={() => { setReveal(false); setRevealReason(''); }}>
        <ReasonField id="rev-reason" value={revealReason} onChange={setRevealReason} />
      </StepUpDialog>
    </>
  );
}

function DecisionDialog({ state, onClose, onDone }: { state: { rail: Rail; approve: boolean } | null; onClose: () => void; onDone: () => void }) {
  const [reason, setReason] = useState('');
  const p = state?.rail.pending_proposal;
  return (
    <StepUpDialog open={!!state && !!p} title={state?.approve ? 'Aprobar cuenta' : 'Rechazar propuesta'} confirmLabel={state?.approve ? 'Aprobar' : 'Rechazar'} destructive={!state?.approve} canSubmit={ok(reason)}
      description={state && p && <>{state.rail.label}: versión {p.version}, •••• {p.last4}. Campos cambiados: {p.changed_fields.join(', ')}.
        {p.holder_type === 'persona' && <span role="alert" className="mt-2 block text-warning">{PERSONAL_RISK} Al aprobar acepta este riesgo (queda en la bitácora).{state.approve && state.rail.visibility !== 'restricted' && ' El riel debe estar en «Solo asignados» antes de aprobar.'}</span>}</>}
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
