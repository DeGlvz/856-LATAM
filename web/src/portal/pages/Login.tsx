import { useState, type FormEvent } from 'react';
import { Link, Navigate, useLocation, useNavigate } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, KeyRound, Loader2, Lock, Wallet } from 'lucide-react';
import { ApiError, papi, type PortalUser } from '../api';
import { usePortal } from '../auth';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

export function AuthShell({ title, desc, children }: { title: string; desc: string; children: React.ReactNode }) {
  return (
    <div className="grid min-h-dvh place-items-center bg-sidebar p-4">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <div className="mb-2 grid size-10 place-items-center rounded-lg bg-primary text-primary-foreground"><Wallet className="size-5" /></div>
          <CardTitle className="text-lg">{title}</CardTitle>
          <CardDescription>{desc}</CardDescription>
        </CardHeader>
        <CardContent>{children}</CardContent>
      </Card>
    </div>
  );
}

export function PortalLogin() {
  const { me } = usePortal();
  const qc = useQueryClient();
  const nav = useNavigate();
  const loc = useLocation();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [mfa, setMfa] = useState<string | null>(null);
  const [useRecovery, setUseRecovery] = useState(false);
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (me) return <Navigate to="/" replace />;

  const done = async () => { await qc.invalidateQueries({ queryKey: ['portal-me'] }); nav((loc.state as { from?: string } | null)?.from ?? '/', { replace: true }); };
  const fail = (e: unknown) => setError(e instanceof ApiError && e.status === 429 ? 'Demasiados intentos. Espere un minuto.' : e instanceof ApiError ? e.message : 'No se pudo conectar con el servidor');

  async function submit(e: FormEvent) {
    e.preventDefault(); setBusy(true); setError(null);
    try {
      const r = await papi<{ mfa_required?: boolean; mfa_token?: string; user?: PortalUser }>('/auth/login', { method: 'POST', json: { email, password } });
      setPassword('');
      if (r.mfa_required) { setMfa(r.mfa_token!); setCode(''); } else await done();
    } catch (err) { fail(err); } finally { setBusy(false); }
  }
  async function submitCode(e: FormEvent) {
    e.preventDefault(); setBusy(true); setError(null);
    try {
      await papi('/auth/login/totp', { method: 'POST', json: useRecovery ? { mfa_token: mfa, recovery_code: code } : { mfa_token: mfa, code } });
      await done();
    } catch (err) { fail(err); if (err instanceof ApiError && err.code === 'invalid_challenge') setMfa(null); } finally { setBusy(false); }
  }

  return (
    <AuthShell title="Portal de clientes" desc={mfa ? 'Verificación en dos pasos' : 'Acceso para usuarios autorizados de su empresa.'}>
      {!mfa ? (
        <form onSubmit={submit} className="grid gap-4">
          <div className="grid gap-2"><Label htmlFor="email">Correo</Label>
            <Input id="email" type="email" autoComplete="username" required autoFocus value={email} onChange={(e) => setEmail(e.target.value)} /></div>
          <div className="grid gap-2"><Label htmlFor="password">Contraseña</Label>
            <Input id="password" type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} /></div>
          {error && <p role="alert" className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p>}
          <Button type="submit" disabled={busy}>{busy ? <Loader2 className="animate-spin" /> : <Lock />}Entrar</Button>
          <p className="text-center text-xs text-muted-foreground">¿Recibió una invitación? Ábrala desde el enlace que le compartió su administrador.</p>
        </form>
      ) : (
        <form onSubmit={submitCode} className="grid gap-4">
          <div className="grid gap-2">
            <Label htmlFor="totp">{useRecovery ? 'Código de recuperación' : 'Código de su app de autenticación'}</Label>
            {useRecovery
              ? <Input id="totp" autoFocus autoComplete="off" placeholder="xxxxx-xxxxx" className="text-center font-mono" value={code} onChange={(e) => setCode(e.target.value.trim())} />
              : <Input id="totp" inputMode="numeric" autoComplete="one-time-code" autoFocus maxLength={6} placeholder="000000"
                  className="text-center font-mono text-lg tracking-[0.4em]" value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} />}
          </div>
          {error && <p role="alert" className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p>}
          <Button type="submit" disabled={busy || (useRecovery ? code.length < 10 : code.length !== 6)}>{busy ? <Loader2 className="animate-spin" /> : <KeyRound />}Verificar</Button>
          <Button type="button" variant="link" size="sm" onClick={() => { setUseRecovery(!useRecovery); setCode(''); setError(null); }}>
            {useRecovery ? 'Usar la app de autenticación' : 'Perdí mi teléfono: usar un código de recuperación'}</Button>
          <Button type="button" variant="ghost" onClick={() => { setMfa(null); setError(null); }}><ArrowLeft />Volver</Button>
        </form>
      )}
      <div className="mt-4 text-center text-[11px] text-muted-foreground"><Link to="/login" className="hover:underline">856-LATAM</Link></div>
    </AuthShell>
  );
}
