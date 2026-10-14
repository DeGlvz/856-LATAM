import { useEffect, useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import { useMutation } from '@tanstack/react-query';
import { ArrowRight, KeyRound, Loader2, ShieldCheck, ShieldOff, UsersRound } from 'lucide-react';
import { api, opError } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { CodeInput, CopyButton, ErrorBox } from '@/components/common';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

export function Security() {
  const { operator, can } = useAuth();
  return (
    <div className="mx-auto grid max-w-5xl grid-cols-[minmax(0,1fr)] gap-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Seguridad</h1>
        <p className="text-sm text-muted-foreground">Segundo factor (TOTP) para entrar a la consola y para aprobar retiros y corridas.</p>
      </div>
      {operator && <MyTwoFactor />}
      {can('tesorero') && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2"><UsersRound className="size-4" />Operadores</CardTitle>
            <CardDescription>Altas por invitación, roles, desactivación y restablecimiento del 2FA de otros operadores.</CardDescription>
            <CardAction><Button asChild size="sm" variant="outline"><Link to="/operadores">Administrar operadores<ArrowRight /></Link></Button></CardAction>
          </CardHeader>
        </Card>
      )}
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
            <ErrorBox error={opError(disable.error)} className="w-full" />
          </form>
        )}
      </CardContent>
    </Card>
  );
}
