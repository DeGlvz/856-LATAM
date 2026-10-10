import { useState, type FormEvent } from 'react';
import { Navigate, useLocation, useNavigate } from 'react-router';
import { Loader2, Lock } from 'lucide-react';
import { useAuth } from '@/lib/auth';
import { ApiError } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

export function Login() {
  const { operator, login } = useAuth();
  const nav = useNavigate();
  const loc = useLocation();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (operator) return <Navigate to="/" replace />;

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      await login(email, password);
      setPassword('');
      nav((loc.state as { from?: string } | null)?.from ?? '/', { replace: true });
    } catch (err) {
      setError(err instanceof ApiError && err.status === 429 ? 'Demasiados intentos. Espere un minuto.'
        : err instanceof ApiError ? err.message : 'No se pudo conectar con el servidor');
    } finally { setBusy(false); }
  }

  return (
    <div className="grid min-h-dvh place-items-center bg-sidebar p-4">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <div className="mb-2 grid size-10 place-items-center rounded-lg bg-primary font-mono text-xs font-bold text-primary-foreground">856</div>
          <CardTitle className="text-lg">Consola de operación</CardTitle>
          <CardDescription>Acceso exclusivo para operadores autorizados.</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={submit} className="grid gap-4">
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
        </CardContent>
      </Card>
    </div>
  );
}
