import { useEffect, useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import { useMutation, useQuery } from '@tanstack/react-query';
import { CheckCircle2, Loader2 } from 'lucide-react';
import { papi } from '../api';
import { AuthShell } from './Login';
import { ErrorBox, Field } from '@/components/common';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

// El token viaja en el fragmento (#): nunca se envía al servidor en la URL ni queda en registros
export function ResetPassword() {
  const [token] = useState(() => window.location.hash.slice(1));
  useEffect(() => { if (token) history.replaceState(null, '', window.location.pathname); }, [token]);
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  const info = useQuery({
    queryKey: ['pw-reset', token], enabled: !!token, retry: false,
    queryFn: () => papi<{ email: string; client_name: string }>('/password-reset/lookup', { method: 'POST', json: { token } }),
  });
  const accept = useMutation({ mutationFn: () => papi('/password-reset/accept', { method: 'POST', json: { token, password: pw } }) });
  const valid = pw.length >= 12 && pw === pw2;

  if (!token) return <AuthShell title="Restablecer contraseña" desc="Abra el enlace completo que le compartió 856."><Link className="text-sm underline" to="/login">Ir al acceso</Link></AuthShell>;
  if (accept.isSuccess) {
    return (
      <AuthShell title="Contraseña actualizada" desc="Ya puede entrar con su nueva contraseña.">
        <div className="grid gap-3 text-sm">
          <p className="flex items-center gap-2"><CheckCircle2 className="size-4 text-success" />Las sesiones anteriores se cerraron.</p>
          <Button asChild><Link to="/login">Entrar</Link></Button>
        </div>
      </AuthShell>
    );
  }
  return (
    <AuthShell title="Nueva contraseña" desc={info.data ? `Cuenta ${info.data.email} · ${info.data.client_name}` : 'Verificando el enlace…'}>
      {info.isPending && <Loader2 className="mx-auto animate-spin" />}
      <ErrorBox error={info.error} />
      {info.data && (
        <form className="grid gap-4" onSubmit={(e: FormEvent) => { e.preventDefault(); accept.mutate(); }}>
          <Field label="Contraseña" htmlFor="rp-pw" hint="Mínimo 12 caracteres.">
            <Input id="rp-pw" type="password" autoComplete="new-password" autoFocus value={pw} onChange={(e) => setPw(e.target.value)} /></Field>
          <Field label="Confirmar contraseña" htmlFor="rp-pw2">
            <Input id="rp-pw2" type="password" autoComplete="new-password" value={pw2} onChange={(e) => setPw2(e.target.value)} aria-invalid={pw2 !== '' && pw !== pw2} /></Field>
          <ErrorBox error={accept.error} />
          <Button type="submit" disabled={!valid || accept.isPending}>{accept.isPending && <Loader2 className="animate-spin" />}Guardar contraseña</Button>
        </form>
      )}
    </AuthShell>
  );
}
