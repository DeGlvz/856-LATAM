import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link2, Loader2, RotateCcw, UserPlus, X } from 'lucide-react';
import { papi, ROLE_HELP, ROLE_LABEL, type ClientRole, type InviteRow, type UserRow } from '../api';
import { usePortal } from '../auth';
import { CopyButton, ErrorBox, Field, fmtDate } from '@/components/common';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';

const ROLES: ClientRole[] = ['viewer', 'operator', 'approver', 'admin'];

export function Users() {
  const { me } = usePortal();
  const qc = useQueryClient();
  const users = useQuery({ queryKey: ['p-users'], queryFn: () => papi<{ users: UserRow[] }>('/users').then((r) => r.users) });
  const invites = useQuery({ queryKey: ['p-invites'], queryFn: () => papi<{ invites: InviteRow[] }>('/users/invites').then((r) => r.invites) });
  const refresh = () => ['p-users', 'p-invites'].forEach((k) => qc.invalidateQueries({ queryKey: [k] }));
  const patch = useMutation({ mutationFn: (v: { id: string; role?: ClientRole; active?: boolean }) => papi(`/users/${v.id}`, { method: 'PATCH', json: { role: v.role, active: v.active } }), onSuccess: refresh });
  const revoke = useMutation({ mutationFn: (id: string) => papi(`/users/invites/${id}/revoke`, { method: 'POST', json: {} }), onSuccess: refresh });
  const [inviting, setInviting] = useState(false);
  const [resetting, setResetting] = useState<UserRow | null>(null);
  const admins = (users.data ?? []).filter((u) => u.role === 'admin' && u.active).length;

  return (
    <div className="mx-auto grid max-w-6xl grid-cols-[minmax(0,1fr)] gap-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Usuarios</h1>
          <p className="text-sm text-muted-foreground">Quién de su empresa entra al portal y qué puede hacer. Los cambios aplican de inmediato.</p>
        </div>
        <Button onClick={() => setInviting(true)}><UserPlus />Invitar usuario</Button>
      </div>
      {admins < 2 && users.data && (
        <div className="rounded-md border border-warning/60 bg-warning/10 px-3 py-2 text-sm">
          Recomendación: tenga al menos <b>dos administradores</b>. Si uno pierde su acceso, el otro puede restablecerlo sin trámites con 856.
        </div>
      )}
      <ErrorBox error={users.error ?? patch.error} />
      <Card className="py-2"><CardContent className="px-3">
        <Table>
          <TableHeader><TableRow><TableHead>Usuario</TableHead><TableHead>Rol</TableHead><TableHead>2FA</TableHead><TableHead>Último acceso</TableHead><TableHead /></TableRow></TableHeader>
          <TableBody>
            {users.data?.map((u) => {
              const self = u.id === me?.user.id;
              return (
                <TableRow key={u.id} className={u.active ? undefined : 'opacity-60'}>
                  <TableCell><div className="text-sm font-medium">{u.name}{self && <span className="text-muted-foreground"> (usted)</span>}</div><div className="text-xs text-muted-foreground">{u.email}</div></TableCell>
                  <TableCell>
                    <Select aria-label={`Rol de ${u.email}`} className="h-8 w-40" value={u.role} disabled={self || patch.isPending} onChange={(e) => patch.mutate({ id: u.id, role: e.target.value as ClientRole })}>
                      {ROLES.map((r) => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}
                    </Select>
                  </TableCell>
                  <TableCell>{u.totp_enabled ? <Badge variant="success">Activo · {u.recovery_codes_left} códigos</Badge> : <Badge variant="secondary">Inactivo</Badge>}</TableCell>
                  <TableCell className="text-xs text-muted-foreground">{u.last_login_at ? fmtDate(u.last_login_at) : 'Nunca'}</TableCell>
                  <TableCell className="text-right whitespace-nowrap">
                    {!self && u.totp_enabled && <Button size="sm" variant="ghost" onClick={() => setResetting(u)}><RotateCcw />Restablecer 2FA</Button>}
                    {!self && <Button size="sm" variant="ghost" onClick={() => patch.mutate({ id: u.id, active: !u.active })}>{u.active ? 'Desactivar' : 'Activar'}</Button>}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </CardContent></Card>
      <Card>
        <CardHeader><CardTitle>Invitaciones pendientes</CardTitle><CardDescription>Enlaces de un solo uso que aún no se aceptan.</CardDescription>
          <CardAction /></CardHeader>
        <CardContent>
          {!invites.data?.length ? <p className="text-sm text-muted-foreground">Sin invitaciones pendientes.</p> : (
            <Table><TableBody>
              {invites.data.map((i) => (
                <TableRow key={i.id}>
                  <TableCell className="text-sm">{i.email}</TableCell><TableCell><Badge variant="outline">{ROLE_LABEL[i.role]}</Badge></TableCell>
                  <TableCell className="text-xs text-muted-foreground">vence {fmtDate(i.expires_at)}</TableCell>
                  <TableCell className="text-right"><Button size="sm" variant="ghost" onClick={() => revoke.mutate(i.id)}><X />Revocar</Button></TableCell>
                </TableRow>
              ))}
            </TableBody></Table>
          )}
        </CardContent>
      </Card>
      <InviteDialog open={inviting} onOpenChange={setInviting} onDone={refresh} />
      <ResetDialog user={resetting} onClose={() => setResetting(null)} onDone={refresh} />
    </div>
  );
}

function InviteDialog({ open, onOpenChange, onDone }: { open: boolean; onOpenChange: (v: boolean) => void; onDone: () => void }) {
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<ClientRole>('operator');
  const m = useMutation({ mutationFn: () => papi<InviteRow>('/users/invites', { method: 'POST', json: { email, role } }), onSuccess: onDone });
  const link = m.data?.link ? `${window.location.origin}${m.data.link}` : null;
  return (
    <Dialog open={open} onOpenChange={(v) => { onOpenChange(v); if (!v) { setEmail(''); setRole('operator'); m.reset(); } }}>
      <DialogContent>
        <DialogHeader><DialogTitle>Invitar usuario</DialogTitle>
          <DialogDescription>Se genera un enlace de un solo uso. Compártalo por un canal confiable; la persona define su propia contraseña.</DialogDescription></DialogHeader>
        {link ? (
          <div className="grid gap-3 text-sm">
            <p className="flex items-center gap-2 font-medium"><Link2 className="size-4" />Enlace de invitación (se muestra una sola vez)</p>
            <div className="flex items-center gap-1 rounded-md bg-muted px-2 py-1.5 font-mono text-xs break-all">{link}<CopyButton value={link} /></div>
            <p className="text-muted-foreground">Vence {fmtDate(m.data!.expires_at)}.</p>
            <DialogFooter><Button onClick={() => onOpenChange(false)}>Listo</Button></DialogFooter>
          </div>
        ) : (
          <form className="grid gap-4" onSubmit={(e: FormEvent) => { e.preventDefault(); m.mutate(); }}>
            <Field label="Correo" htmlFor="inv-email"><Input id="inv-email" type="email" autoFocus value={email} onChange={(e) => setEmail(e.target.value)} /></Field>
            <Field label="Rol" htmlFor="inv-role" hint={ROLE_HELP[role]}>
              <Select id="inv-role" value={role} onChange={(e) => setRole(e.target.value as ClientRole)}>{ROLES.map((r) => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}</Select>
            </Field>
            <ErrorBox error={m.error} />
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>Cancelar</Button>
              <Button type="submit" disabled={!/^\S+@\S+\.\S+$/.test(email) || m.isPending}>{m.isPending && <Loader2 className="animate-spin" />}Generar enlace</Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}

function ResetDialog({ user, onClose, onDone }: { user: UserRow | null; onClose: () => void; onDone: () => void }) {
  const [reason, setReason] = useState('');
  const m = useMutation({ mutationFn: () => papi(`/users/${user!.id}/totp/reset`, { method: 'POST', json: { reason: reason.trim() } }), onSuccess: () => { onDone(); onClose(); setReason(''); } });
  return (
    <Dialog open={!!user} onOpenChange={(v) => !v && onClose()}>
      <DialogContent>
        <DialogHeader><DialogTitle>Restablecer 2FA de {user?.email}</DialogTitle>
          <DialogDescription>Borra su verificación en dos pasos y sus códigos, y cierra sus sesiones. Deberá activarla de nuevo. Queda en la bitácora con el motivo.</DialogDescription></DialogHeader>
        <form className="grid gap-3" onSubmit={(e: FormEvent) => { e.preventDefault(); m.mutate(); }}>
          <Input aria-label="Motivo" autoFocus maxLength={300} placeholder="Motivo (mín. 5 caracteres)" value={reason} onChange={(e) => setReason(e.target.value)} />
          <ErrorBox error={m.error} />
          <DialogFooter><Button type="button" variant="outline" onClick={onClose}>Cancelar</Button>
            <Button type="submit" variant="destructive" disabled={reason.trim().length < 5 || m.isPending}>Restablecer</Button></DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
