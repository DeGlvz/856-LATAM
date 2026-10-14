import { useState, type FormEvent } from 'react';
import { Navigate, useLocation, useNavigate } from 'react-router';
import { ArrowLeft, KeyRound, Loader2, Lock } from 'lucide-react';
import { useAuth } from '@/lib/auth';
import { ApiError } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

export function Login() {
  const { operator, login, verifyTotp } = useAuth();
  const nav = useNavigate();
  const loc = useLocation();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [mfaToken, setMfaToken] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const notice = (loc.state as { notice?: string } | null)?.notice;
  if (operator) return <Navigate to="/" replace />;
  const done = () => nav((loc.state as { from?: string } | null)?.from ?? '/', { replace: true });
  const fail = (err: unknown) => setError(err instanceof ApiError && err.status === 429 ? 'Demasiados intentos. Espere un minuto.'
    : err instanceof ApiError ? err.message : 'No se pudo conectar con el servidor');

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      const token = await login(email, password);
      setPassword('');
      if (token) { setMfaToken(token); setCode(''); } else done();
    } catch (err) { fail(err); } finally { setBusy(false); }
  }

  async function submitCode(e: FormEvent) {
    e.preventDefault();
    setBusy(true); setError(null);
    try { await verifyTotp(mfaToken!, code); done(); } catch (err) {
      fail(err);
      // Reto vencido o agotado: volver al primer paso
      if (err instanceof ApiError && err.code === 'invalid_challenge') setMfaToken(null);
    } finally { setBusy(false); }
  }

  return (
    <div className="grid min-h-dvh place-items-center bg-sidebar p-4">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <div className="mb-2 grid size-10 place-items-center rounded-lg bg-primary font-mono text-xs font-bold text-primary-foreground">856</div>
          <CardTitle className="text-lg">Consola de operación</CardTitle>
          <CardDescription>{mfaToken ? 'Verificación en dos pasos' : 'Acceso exclusivo para operadores autorizados.'}</CardDescription>
        </CardHeader>
        <CardContent>
          {!mfaToken ? (
            <form onSubmit={submit} className="grid gap-4">
              {notice && <p role="status" className="rounded-md bg-success/10 px-3 py-2 text-sm text-success">{notice}</p>}
              <div className="grid gap-2">
                <Label htmlFor="email">Correo</Label>
                <Input id="email" type="email" autoComplete="username" required autoFocus value={email} onChange={(e) => setEmail(e.target.value)} />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="password">Contraseña</Label>
                <Input id="password" type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
              </div>
              {error && <p role="alert" className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p>}
              <Button type="submit" disabled={busy}>{busy ? <Loader2 className="animate-spin" /> : <Lock />}Entrar</Button>
            </form>
          ) : (
            <form onSubmit={submitCode} className="grid gap-4">
              <div className="grid gap-2">
                <Label htmlFor="totp">Código de su app de autenticación</Label>
                <Input id="totp" inputMode="numeric" autoComplete="one-time-code" autoFocus maxLength={6} placeholder="000000"
                  className="text-center font-mono text-lg tracking-[0.4em]" value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} />
                <p className="text-xs text-muted-foreground">El código cambia cada 30 segundos y solo sirve una vez.</p>
              </div>
              {error && <p role="alert" className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p>}
              <Button type="submit" disabled={busy || code.length !== 6}>{busy ? <Loader2 className="animate-spin" /> : <KeyRound />}Verificar</Button>
              <Button type="button" variant="ghost" onClick={() => { setMfaToken(null); setError(null); }}><ArrowLeft />Volver</Button>
            </form>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
