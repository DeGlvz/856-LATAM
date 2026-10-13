import { useEffect, useState, type FormEvent } from 'react';
import { useMutation } from '@tanstack/react-query';
import { AlertTriangle, Download, KeyRound, Loader2, ShieldCheck, ShieldOff } from 'lucide-react';
import { papi } from '../api';
import { usePortal } from '../auth';
import { download } from '../crypto';
import { CopyButton, ErrorBox } from '@/components/common';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';

export const CodeInput = ({ value, onChange, label }: { value: string; onChange: (v: string) => void; label: string }) => (
  <Input aria-label={label} inputMode="numeric" autoComplete="one-time-code" maxLength={6} placeholder="000000"
    className="h-10 w-40 text-center font-mono text-lg tracking-[0.3em]" value={value} onChange={(e) => onChange(e.target.value.replace(/\D/g, ''))} />
);

function RecoveryCodes({ codes, email }: { codes: string[]; email: string }) {
  return (
    <div className="grid gap-3 rounded-md border border-warning/60 bg-warning/10 p-4 text-sm">
      <div className="flex items-center gap-2 font-medium"><AlertTriangle className="size-4" />Guarde estos códigos de recuperación ahora: no se volverán a mostrar.</div>
      <p>Cada uno sirve una sola vez para entrar si pierde su teléfono. Guárdelos fuera de este equipo (gestor de contraseñas o impreso en un lugar seguro).</p>
      <ol className="grid grid-cols-2 gap-1 font-mono sm:grid-cols-5">{codes.map((c) => <li key={c} className="rounded bg-background px-2 py-1 text-center">{c}</li>)}</ol>
      <div className="flex gap-2">
        <Button size="sm" variant="outline" onClick={() => download(`856-recuperacion-${email}.txt`, `Códigos de recuperación 856-LATAM · ${email}\n\n${codes.join('\n')}\n`)}><Download />Descargar</Button>
        <CopyButton value={codes.join('\n')} />
      </div>
    </div>
  );
}

export function PortalSecurity() {
  const { me, refresh } = usePortal();
  const [setup, setSetup] = useState<{ secret: string; otpauth_url: string } | null>(null);
  const [qr, setQr] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [codes, setCodes] = useState<string[] | null>(null);
  const start = useMutation({ mutationFn: () => papi<{ secret: string; otpauth_url: string }>('/auth/totp/setup', { method: 'POST', json: {} }), onSuccess: setSetup });
  const enable = useMutation({
    mutationFn: () => papi<{ recovery_codes: string[] }>('/auth/totp/enable', { method: 'POST', json: { code } }),
    onSuccess: async (r) => { setCodes(r.recovery_codes); setSetup(null); setCode(''); await refresh(); },
  });
  const regen = useMutation({
    mutationFn: () => papi<{ recovery_codes: string[] }>('/auth/recovery-codes', { method: 'POST', json: { code } }),
    onSuccess: (r) => { setCodes(r.recovery_codes); setCode(''); },
  });
  useEffect(() => {
    if (!setup) { setQr(null); return; }
    import('qrcode').then((m) => m.default.toDataURL(setup.otpauth_url, { margin: 1, width: 200 })).then(setQr, () => setQr(null));
  }, [setup]);
  if (!me) return null;
  const on = me.user.totp_enabled;

  return (
    <div className="mx-auto grid max-w-3xl grid-cols-[minmax(0,1fr)] gap-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Seguridad</h1>
        <p className="text-sm text-muted-foreground">Verificación en dos pasos (TOTP) y códigos de recuperación.</p>
      </div>
      {me.totp_enrollment_required && (
        <div role="alert" className="flex items-start gap-2 rounded-md border border-warning/60 bg-warning/10 px-3 py-2 text-sm">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" />Su rol exige verificación en dos pasos. Actívela para continuar usando el portal.
        </div>
      )}
      {codes && <RecoveryCodes codes={codes} email={me.user.email} />}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">{on ? <ShieldCheck className="size-4 text-success" /> : <ShieldOff className="size-4" />}Verificación en dos pasos
            <Badge variant={on ? 'success' : 'secondary'}>{on ? 'Activa' : 'Inactiva'}</Badge></CardTitle>
          <CardDescription>Use Google Authenticator, Microsoft Authenticator, 1Password u otra app TOTP.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4">
          {!on && !setup && <div><Button onClick={() => start.mutate()} disabled={start.isPending}>{start.isPending ? <Loader2 className="animate-spin" /> : <KeyRound />}Activar 2FA</Button></div>}
          <ErrorBox error={start.error} />
          {!on && setup && (
            <form className="grid gap-4 md:grid-cols-[auto_1fr]" onSubmit={(e: FormEvent) => { e.preventDefault(); enable.mutate(); }}>
              <div className="grid place-items-center rounded-lg border bg-white p-2">
                {qr ? <img src={qr} alt="Código QR para la app de autenticación" width={200} height={200} /> : <div className="size-[200px]" />}
              </div>
              <div className="grid content-start gap-3 text-sm">
                <p>1. Escanee el código QR con su app. Si no puede, capture esta clave:</p>
                <div className="flex items-center gap-1 rounded-md bg-muted px-2 py-1.5 font-mono text-xs break-all">{setup.secret.match(/.{1,4}/g)?.join(' ')}<CopyButton value={setup.secret} /></div>
                <p>2. Escriba el código de 6 dígitos que muestra la app:</p>
                <div className="flex flex-wrap items-center gap-2">
                  <CodeInput label="Código para activar 2FA" value={code} onChange={setCode} />
                  <Button type="submit" disabled={code.length !== 6 || enable.isPending}>{enable.isPending && <Loader2 className="animate-spin" />}Confirmar y activar</Button>
                </div>
                <ErrorBox error={enable.error} />
              </div>
            </form>
          )}
          {on && (
            <form className="flex flex-wrap items-center gap-2 text-sm" onSubmit={(e: FormEvent) => { e.preventDefault(); regen.mutate(); }}>
              <span className="text-muted-foreground">¿Usó o perdió sus códigos de recuperación? Genere nuevos (los anteriores dejan de servir):</span>
              <CodeInput label="Código para regenerar códigos de recuperación" value={code} onChange={setCode} />
              <Button type="submit" variant="outline" disabled={code.length !== 6 || regen.isPending}>Generar nuevos</Button>
              <ErrorBox error={regen.error} className="w-full" />
            </form>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
