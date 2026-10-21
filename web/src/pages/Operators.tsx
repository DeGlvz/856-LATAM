import { useEffect, useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Link2, Loader2, Power, PowerOff, RotateCcw, Send, UserPlus, X } from 'lucide-react';
import { api, opError, type OperatorInvite, type OperatorRow, type Role } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { CopyButton, ErrorBox, Field, fmtDate } from '@/components/common';
import { StepUpDialog } from '@/components/StepUpDialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';

const ROLES: Role[] = ['lectura', 'ejecutivo', 'tesorero'];
export const ROLE_LABEL = { lectura: 'Lectura', ejecutivo: 'Ejecutivo de cuenta', tesorero: 'Tesorero' } as const;
const ROLE_HELP: Record<Role, string> = {
  lectura: 'Solo consulta: tablero, clientes, movimientos.',
  ejecutivo: 'Atención a clientes: altas, cuentas, obligaciones y validación previa; no autoriza salidas.',
  tesorero: 'Superusuario: autoriza salidas, aprobaciones, compensación y administración de operadores.',
};
const ROLE_VARIANT: Record<Role, 'outline' | 'secondary' | 'default'> = { lectura: 'outline', ejecutivo: 'secondary', tesorero: 'default' };
const SELF_TIP = 'No puede modificarse a sí mismo: pídalo a otro tesorero';

type Pending =
  | { kind: 'role'; op: OperatorRow; role: Role }
  | { kind: 'active'; op: OperatorRow; active: boolean }
  | { kind: 'revoke'; invite: OperatorInvite };

function StatusBadge({ o }: { o: OperatorRow }) {
  if (!o.active) return <Badge variant="destructive" title={o.deactivated_at ? `Desde ${fmtDate(o.deactivated_at)}${o.deactivated_by ? ` por ${o.deactivated_by}` : ''}` : undefined}>Desactivado</Badge>;
  if (o.locked_until && new Date(o.locked_until) > new Date()) return <Badge variant="warning" title={`Hasta ${fmtDate(o.locked_until)}`}>Bloqueado</Badge>;
  return <Badge variant="success">Activo</Badge>;
}

export function Operators() {
  const { operator } = useAuth();
  const qc = useQueryClient();
  const ops = useQuery({ queryKey: ['operators'], queryFn: () => api<{ operators: OperatorRow[] }>('/operators').then((r) => r.operators) });
  const invites = useQuery({ queryKey: ['operator-invites'], queryFn: () => api<{ invites: OperatorInvite[] }>('/operators/invites').then((r) => r.invites) });
  const refresh = () => { qc.invalidateQueries({ queryKey: ['operators'] }); qc.invalidateQueries({ queryKey: ['operator-invites'] }); };
  const [pending, setPending] = useState<Pending | null>(null);
  const [inviting, setInviting] = useState(false);
  const [reset, setReset] = useState<OperatorRow | null>(null);
  const [resend, setResend] = useState<{ email: string; path: string } | null>(null);
  const has2fa = !!operator?.totp_enabled;
  const tes2fa = (ops.data ?? []).filter((o) => o.role === 'tesorero' && o.active && o.totp_enabled).length;

  const confirm = async (code: string) => {
    const p = pending!;
    if (p.kind === 'revoke') await api(`/operators/invites/${p.invite.id}/revoke`, { method: 'POST', json: { code } });
    else await api(`/operators/${p.op.id}`, { method: 'PATCH', json: p.kind === 'role' ? { role: p.role, code } : { active: p.active, code } });
    refresh();
  };
  const dlg = !pending ? null
    : pending.kind === 'role' ? { title: `Cambiar rol de ${pending.op.email}`, label: 'Cambiar rol', destructive: false,
      desc: <>Pasará de <b>{ROLE_LABEL[pending.op.role]}</b> a <b>{ROLE_LABEL[pending.role]}</b>. Sus sesiones abiertas se cierran y deberá volver a entrar.</> }
      : pending.kind === 'active' ? pending.active
        ? { title: `Reactivar a ${pending.op.email}`, label: 'Reactivar', destructive: false, desc: <>Podrá volver a entrar con su contraseña{pending.op.totp_enabled ? ' y su 2FA' : ''}. No se restauran sesiones anteriores.</> }
        : { title: `Desactivar a ${pending.op.email}`, label: 'Desactivar', destructive: true, desc: <>No podrá entrar y sus sesiones se cierran de inmediato. Su historial en la bitácora se conserva.</> }
        : { title: `Revocar invitación a ${pending.invite.email}`, label: 'Revocar', destructive: true, desc: <>El enlace deja de funcionar. Podrá emitir uno nuevo para ese correo.</> };

  return (
    <div className="mx-auto grid max-w-6xl grid-cols-[minmax(0,1fr)] gap-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Operadores</h1>
          <p className="text-sm text-muted-foreground">Quién entra a la consola y con qué rol. Cada cambio pide su código 2FA y queda en la bitácora.</p>
        </div>
        <Button onClick={() => setInviting(true)} disabled={!has2fa} title={has2fa ? undefined : 'Active su 2FA para invitar'}><UserPlus />Invitar operador</Button>
      </div>

      {!has2fa && (
        <div role="status" className="flex items-start gap-2 rounded-md border border-warning/60 bg-warning/10 px-3 py-2 text-sm">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" />
          <span>Para administrar operadores necesita su verificación en dos pasos activa. <Link to="/seguridad" className="font-medium underline">Activar 2FA en Seguridad</Link></span>
        </div>
      )}
      {ops.data && tes2fa < 2 && (
        <div className="rounded-md border border-warning/60 bg-warning/10 px-3 py-2 text-sm">
          Hay <b>{tes2fa}</b> tesorero(s) activo(s) con 2FA. La doble aprobación de liquidaciones y la recuperación de accesos necesitan al menos <b>dos</b>.
        </div>
      )}

      <Card className="py-2"><CardContent className="px-3">
        <ErrorBox error={ops.error} />
        {ops.isPending ? <Skeleton className="m-2 h-40" /> : (
          <Table>
            <TableHeader><TableRow>
              <TableHead>Operador</TableHead><TableHead>Rol</TableHead><TableHead>2FA</TableHead><TableHead>Último acceso</TableHead>
              <TableHead className="text-right">Sesiones</TableHead><TableHead>Estado</TableHead><TableHead className="text-right">Acciones</TableHead>
            </TableRow></TableHeader>
            <TableBody>
              {ops.data?.map((o) => {
                const self = o.id === operator?.id;
                const off = !has2fa || self;
                const tip = self ? SELF_TIP : !has2fa ? 'Active su 2FA para administrar operadores' : undefined;
                return (
                  <TableRow key={o.id} className={o.active ? undefined : 'opacity-70'} data-email={o.email}>
                    <TableCell><div className="text-sm font-medium">{o.name}{self && <span className="text-muted-foreground"> (usted)</span>}</div><div className="text-xs text-muted-foreground">{o.email}</div></TableCell>
                    <TableCell>
                      <div className="flex items-center gap-2">
                        <span title={tip}>
                          <Select aria-label={`Cambiar rol de ${o.email}`} className="h-8 w-32" value={o.role} disabled={off || !o.active}
                            onChange={(e) => setPending({ kind: 'role', op: o, role: e.target.value as Role })}>
                            {ROLES.map((r) => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}
                          </Select>
                        </span>
                      </div>
                    </TableCell>
                    <TableCell>{o.totp_enabled ? <Badge variant="success">Activo</Badge> : <Badge variant="secondary">Inactivo</Badge>}</TableCell>
                    <TableCell className="text-xs whitespace-nowrap text-muted-foreground">{o.last_login_at ? fmtDate(o.last_login_at) : 'Nunca'}</TableCell>
                    <TableCell className="num text-right">{o.active_sessions ?? 0}</TableCell>
                    <TableCell><StatusBadge o={o} /></TableCell>
                    <TableCell className="text-right whitespace-nowrap">
                      <span title={tip}>
                        <Button size="sm" variant="ghost" disabled={off} onClick={() => setPending({ kind: 'active', op: o, active: !o.active })}
                          aria-label={`${o.active ? 'Desactivar' : 'Reactivar'} a ${o.email}`}>
                          {o.active ? <><PowerOff />Desactivar</> : <><Power />Reactivar</>}
                        </Button>
                      </span>
                      {o.active && (
                        <span title={self ? 'Pida a otro tesorero que le reenvíe el acceso' : tip}>
                          <Button size="sm" variant="ghost" disabled={off} aria-label={`Reenviar acceso a ${o.email}`}
                            onClick={() => setResend({ email: o.email, path: `/operators/${o.id}/access-link` })}><Send />Reenviar acceso</Button>
                        </span>
                      )}
                      {o.totp_enabled && (
                        <span title={self ? 'No puede restablecer su propio 2FA' : undefined}>
                          <Button size="sm" variant="ghost" disabled={self} onClick={() => setReset(o)} aria-label={`Restablecer 2FA de ${o.email}`}><RotateCcw />Restablecer 2FA</Button>
                        </span>
                      )}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
      </CardContent></Card>

      <Card>
        <CardHeader>
          <CardTitle>Invitaciones pendientes</CardTitle>
          <CardDescription>Enlaces de un solo uso que aún no se aceptan. El enlace solo se muestra al crearlo.</CardDescription>
          <CardAction />
        </CardHeader>
        <CardContent>
          <ErrorBox error={invites.error} />
          {!invites.data?.length ? <p className="text-sm text-muted-foreground">Sin invitaciones pendientes.</p> : (
            <Table>
              <TableHeader><TableRow><TableHead>Correo</TableHead><TableHead>Rol</TableHead><TableHead>Invitó</TableHead><TableHead>Vence</TableHead><TableHead /></TableRow></TableHeader>
              <TableBody>
                {invites.data.map((i) => (
                  <TableRow key={i.id}>
                    <TableCell className="text-sm">{i.email}</TableCell>
                    <TableCell><Badge variant={ROLE_VARIANT[i.role]}>{ROLE_LABEL[i.role]}</Badge></TableCell>
                    <TableCell className="text-xs text-muted-foreground">{i.created_by}</TableCell>
                    <TableCell className="text-xs whitespace-nowrap text-muted-foreground">{fmtDate(i.expires_at)}</TableCell>
                    <TableCell className="text-right whitespace-nowrap">
                      <Button size="sm" variant="ghost" disabled={!has2fa} onClick={() => setResend({ email: i.email, path: `/operators/invites/${i.id}/resend` })} aria-label={`Reenviar invitación a ${i.email}`}><Send />Reenviar</Button>
                      <Button size="sm" variant="ghost" disabled={!has2fa} onClick={() => setPending({ kind: 'revoke', invite: i })} aria-label={`Revocar invitación a ${i.email}`}><X />Revocar</Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <p className="text-xs text-muted-foreground">Su propia verificación en dos pasos se administra en <Link to="/seguridad" className="underline">Seguridad</Link>.</p>

      {dlg && <StepUpDialog open title={dlg.title} description={dlg.desc} confirmLabel={dlg.label} destructive={dlg.destructive}
        onConfirm={confirm} onClose={() => setPending(null)} />}
      <ResendDialog target={resend} onClose={() => setResend(null)} onDone={refresh} />
      <InviteDialog open={inviting} onClose={() => setInviting(false)} onDone={refresh} />
      <ResetDialog target={reset} onClose={() => setReset(null)} onDone={refresh} />
    </div>
  );
}

type Created = { id: string; email: string; role: Role; expires_at: string; link: string };

/** Reenviar acceso o invitación: emite un enlace nuevo de un solo uso (los anteriores dejan de funcionar). */
function ResendDialog({ target, onClose, onDone }: { target: { email: string; path: string } | null; onClose: () => void; onDone: () => void }) {
  return (
    <StepUpDialog<Created> open={!!target} keepOpen title={`Reenviar acceso a ${target?.email ?? ''}`} confirmLabel="Generar enlace"
      description="Se genera un enlace nuevo de un solo uso para definir contraseña; el anterior deja de funcionar. Entréguelo por un canal confiable."
      onConfirm={async (code) => { const r = await api<Created>(target!.path, { method: 'POST', json: { code } }); onDone(); return r; }}
      result={(r) => {
        const link = `${window.location.origin}${r.link}`;
        return <>
          <p className="flex items-center gap-2 font-medium"><Link2 className="size-4" />Enlace para {r.email} — se muestra una sola vez</p>
          <div data-testid="resend-link" className="flex items-center gap-1 rounded-md bg-muted px-2 py-1.5 font-mono text-xs break-all">{link}<CopyButton value={link} /></div>
          <p className="text-muted-foreground">Vence: {fmtDate(r.expires_at)}</p>
        </>;
      }}
      onClose={onClose} />
  );
}

function InviteDialog({ open, onClose, onDone }: { open: boolean; onClose: () => void; onDone: () => void }) {
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<Role>('ejecutivo');
  useEffect(() => { if (open) { setEmail(''); setRole('ejecutivo'); } }, [open]);
  return (
    <StepUpDialog<Created> open={open} keepOpen title="Invitar operador" confirmLabel="Generar enlace"
      description="Se genera un enlace de un solo uso. Entréguelo por un canal confiable; la persona define su nombre y contraseña."
      canSubmit={/^\S+@\S+\.\S+$/.test(email.trim())}
      onConfirm={async (code) => { const r = await api<Created>('/operators/invites', { method: 'POST', json: { email: email.trim(), role, code } }); onDone(); return r; }}
      result={(r) => {
        const link = `${window.location.origin}${r.link}`;
        return <>
          <p className="flex items-center gap-2 font-medium"><Link2 className="size-4" />Enlace para {r.email} ({ROLE_LABEL[r.role]}) — se muestra una sola vez</p>
          <div data-testid="invite-link" className="flex items-center gap-1 rounded-md bg-muted px-2 py-1.5 font-mono text-xs break-all">{link}<CopyButton value={link} /></div>
          <p className="text-muted-foreground">Vence: {fmtDate(r.expires_at)} · Si se pierde, revóquelo y emita otro.</p>
        </>;
      }}
      onClose={onClose}>
      <Field label="Correo" htmlFor="op-inv-email"><Input id="op-inv-email" type="email" autoComplete="off" autoFocus value={email} onChange={(e) => setEmail(e.target.value)} /></Field>
      <Field label="Rol" htmlFor="op-inv-role" hint={ROLE_HELP[role]}>
        <Select id="op-inv-role" value={role} onChange={(e) => setRole(e.target.value as Role)}>{ROLES.map((r) => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}</Select>
      </Field>
    </StepUpDialog>
  );
}

/** Restablecer 2FA de otro operador (teléfono perdido): flujo existente con motivo obligatorio. */
function ResetDialog({ target, onClose, onDone }: { target: OperatorRow | null; onClose: () => void; onDone: () => void }) {
  const [reason, setReason] = useState('');
  const m = useMutation({
    mutationFn: () => api(`/operators/${target!.id}/totp/reset`, { method: 'POST', json: { reason: reason.trim() } }),
    onSuccess: () => { onDone(); onClose(); },
  });
  useEffect(() => { setReason(''); m.reset(); }, [target?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <Dialog open={!!target} onOpenChange={(v) => !v && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Restablecer 2FA de {target?.email}</DialogTitle>
          <DialogDescription>Borra su segundo factor y cierra sus sesiones. Deberá volver a activarlo. Úselo solo si perdió el teléfono; queda en la bitácora con el motivo.</DialogDescription>
        </DialogHeader>
        <form className="grid gap-3" onSubmit={(e: FormEvent) => { e.preventDefault(); m.mutate(); }}>
          <Input aria-label="Motivo" autoFocus maxLength={300} placeholder="Motivo (mín. 5 caracteres)" value={reason} onChange={(e) => setReason(e.target.value)} />
          <ErrorBox error={opError(m.error)} />
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>Cancelar</Button>
            <Button type="submit" variant="destructive" disabled={reason.trim().length < 5 || m.isPending}>{m.isPending && <Loader2 className="animate-spin" />}Restablecer</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
