import { useEffect, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { KeyRound, Loader2, RotateCcw, ShieldCheck, ShieldOff } from 'lucide-react';
import { api, type OperatorRow } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { CopyButton, ErrorBox, fmtDate } from '@/components/common';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';

const ROLE = { lectura: 'Lectura', operador: 'Operador', tesorero: 'Tesorero' } as const;

function CodeInput({ value, onChange, label }: { value: string; onChange: (v: string) => void; label: string }) {
  return (
    <Input aria-label={label} inputMode="numeric" autoComplete="one-time-code" maxLength={6} placeholder="000000"
      className="h-10 w-40 text-center font-mono text-lg tracking-[0.3em]" value={value} onChange={(e) => onChange(e.target.value.replace(/\D/g, ''))} />
  );
}

export function Security() {
  const { operator, can } = useAuth();
  return (
    <div className="mx-auto grid max-w-5xl grid-cols-[minmax(0,1fr)] gap-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Seguridad</h1>
        <p className="text-sm text-muted-foreground">Segundo factor (TOTP) para entrar a la consola y para aprobar retiros y corridas.</p>
      </div>
      {operator && <MyTwoFactor />}
      {can('tesorero') && <OperatorsCard />}
    </div>
  );
}

function MyTwoFactor() {
  const { operator, refresh } = useAuth();
  const [setup, setSetup] = useState<{ secret: string; otpauth_url: string } | null>(null);
  const [qr, setQr] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [disabling, setDisabling] = useState(false);

  const start = useMutation({ mutationFn: () => api<{ secret: string; otpauth_url: string }>('/auth/totp/setup', { method: 'POST', json: {} }), onSuccess: setSetup });
  const enable = useMutation({
    mutationFn: () => api('/auth/totp/enable', { method: 'POST', json: { code } }),
    onSuccess: async () => { setSetup(null); setCode(''); await refresh(); },
  });
  const disable = useMutation({
    mutationFn: () => api('/auth/totp/disable', { method: 'POST', json: { code } }),
    onSuccess: async () => { setDisabling(false); setCode(''); await refresh(); },
  });
  useEffect(() => {
    if (!setup) { setQr(null); return; }
    // Carga diferida: la librería de QR solo se descarga al activar 2FA
    import('qrcode').then((m) => m.default.toDataURL(setup.otpauth_url, { margin: 1, width: 200, errorCorrectionLevel: 'M' })).then(setQr, () => setQr(null));
  }, [setup]);

  const on = !!operator?.totp_enabled;
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">{on ? <ShieldCheck className="size-4 text-success" /> : <ShieldOff className="size-4" />}Mi verificación en dos pasos
          <Badge variant={on ? 'success' : 'secondary'}>{on ? 'Activa' : 'Inactiva'}</Badge></CardTitle>
        <CardDescription>Use Google Authenticator, Microsoft Authenticator, 1Password u otra app TOTP.</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        {!on && !setup && (
          <div className="flex flex-wrap items-center gap-3">
            <Button onClick={() => start.mutate()} disabled={start.isPending}>{start.isPending ? <Loader2 className="animate-spin" /> : <KeyRound />}Activar 2FA</Button>
            <p className="text-sm text-muted-foreground">Necesario para aprobar retiros y corridas.</p>
          </div>
        )}
        <ErrorBox error={start.error} />
        {!on && setup && (
          <form className="grid gap-4 md:grid-cols-[auto_1fr]" onSubmit={(e: FormEvent) => { e.preventDefault(); enable.mutate(); }}>
            <div className="grid place-items-center rounded-lg border bg-white p-2">
              {qr ? <img src={qr} alt="Código QR para la app de autenticación" width={200} height={200} /> : <div className="size-[200px]" />}
            </div>
            <div className="grid content-start gap-3 text-sm">
              <ol className="grid list-decimal gap-1 pl-5">
                <li>Escanee el código QR con su app de autenticación.</li>
                <li>Si no puede escanear, capture esta clave manualmente:</li>
              </ol>
              <div className="flex items-center gap-1 rounded-md bg-muted px-2 py-1.5 font-mono text-xs break-all">{setup.secret.match(/.{1,4}/g)?.join(' ')}<CopyButton value={setup.secret} /></div>
              <p>3. Escriba el código de 6 dígitos que muestra la app:</p>
              <div className="flex flex-wrap items-center gap-2">
                <CodeInput label="Código para activar 2FA" value={code} onChange={setCode} />
                <Button type="submit" disabled={code.length !== 6 || enable.isPending}>{enable.isPending && <Loader2 className="animate-spin" />}Confirmar y activar</Button>
                <Button type="button" variant="ghost" onClick={() => { setSetup(null); setCode(''); }}>Cancelar</Button>
              </div>
              <ErrorBox error={enable.error} />
            </div>
          </form>
        )}
        {on && !disabling && (
          <div className="flex flex-wrap items-center gap-3 text-sm">
            <p className="text-muted-foreground">Se le pedirá un código al entrar y en cada aprobación.</p>
            <Button variant="outline" size="sm" onClick={() => { setDisabling(true); setCode(''); }}>Desactivar…</Button>
          </div>
        )}
        {on && disabling && (
          <form className="flex flex-wrap items-center gap-2 rounded-md border border-destructive/30 p-3 text-sm" onSubmit={(e: FormEvent) => { e.preventDefault(); disable.mutate(); }}>
            <span>Confirme con un código actual:</span>
            <CodeInput label="Código para desactivar 2FA" value={code} onChange={setCode} />
            <Button type="submit" variant="destructive" disabled={code.length !== 6 || disable.isPending}>{disable.isPending && <Loader2 className="animate-spin" />}Desactivar 2FA</Button>
            <Button type="button" variant="ghost" onClick={() => setDisabling(false)}>Cancelar</Button>
            <ErrorBox error={disable.error} className="w-full" />
          </form>
        )}
      </CardContent>
    </Card>
  );
}

function OperatorsCard() {
  const { operator } = useAuth();
  const q = useQuery({ queryKey: ['operators'], queryFn: () => api<{ operators: OperatorRow[] }>('/operators').then((r) => r.operators) });
  const [reset, setReset] = useState<OperatorRow | null>(null);
  const tesoreros2fa = (q.data ?? []).filter((o) => o.role === 'tesorero' && o.active && o.totp_enabled).length;
  return (
    <Card>
      <CardHeader>
        <CardTitle>Operadores</CardTitle>
        <CardDescription>
          Estado del 2FA por operador. La doble aprobación necesita al menos dos tesoreros con 2FA
          {q.data && <> (hoy: <b>{tesoreros2fa}</b>)</>}.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <ErrorBox error={q.error} />
        <Table>
          <TableHeader><TableRow><TableHead>Operador</TableHead><TableHead>Rol</TableHead><TableHead>2FA</TableHead><TableHead>Último acceso</TableHead><TableHead /></TableRow></TableHeader>
          <TableBody>
            {q.data?.map((o) => (
              <TableRow key={o.id}>
                <TableCell><div className="text-sm font-medium">{o.name}</div><div className="text-xs text-muted-foreground">{o.email}</div></TableCell>
                <TableCell><Badge variant="outline">{ROLE[o.role]}</Badge>{!o.active && <Badge variant="secondary" className="ml-1">Inactivo</Badge>}</TableCell>
                <TableCell>{o.totp_enabled ? <Badge variant="success">Activo</Badge> : <Badge variant="secondary">Inactivo</Badge>}</TableCell>
                <TableCell className="text-xs text-muted-foreground">{o.last_login_at ? fmtDate(o.last_login_at) : 'Nunca'}</TableCell>
                <TableCell className="text-right">
                  {o.totp_enabled && o.id !== operator?.id && <Button size="sm" variant="ghost" onClick={() => setReset(o)}><RotateCcw />Restablecer 2FA</Button>}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
        <p className="mt-3 text-xs text-muted-foreground">Altas de operadores: <code className="font-mono">npm run operator:create -- &lt;correo&gt; &lt;rol&gt;</code> en el servidor.</p>
      </CardContent>
      <ResetDialog target={reset} onClose={() => setReset(null)} />
    </Card>
  );
}

function ResetDialog({ target, onClose }: { target: OperatorRow | null; onClose: () => void }) {
  const qc = useQueryClient();
  const [reason, setReason] = useState('');
  const m = useMutation({
    mutationFn: () => api(`/operators/${target!.id}/totp/reset`, { method: 'POST', json: { reason: reason.trim() } }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['operators'] }); onClose(); },
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
          <ErrorBox error={m.error} />
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>Cancelar</Button>
            <Button type="submit" variant="destructive" disabled={reason.trim().length < 5 || m.isPending}>{m.isPending && <Loader2 className="animate-spin" />}Restablecer</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
