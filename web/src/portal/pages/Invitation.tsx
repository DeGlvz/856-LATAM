import { useEffect, useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import { useMutation, useQuery } from '@tanstack/react-query';
import { CheckCircle2, Loader2 } from 'lucide-react';
import { papi, ROLE_HELP, ROLE_LABEL, type ClientRole } from '../api';
import { AuthShell } from './Login';
import { ErrorBox, Field } from '@/components/common';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

// El token viaja en el fragmento (#): nunca se envía al servidor en la URL ni queda en registros
export function Invitation() {
  const [token] = useState(() => window.location.hash.slice(1));
  useEffect(() => { if (token) history.replaceState(null, '', window.location.pathname); }, [token]);
  const [name, setName] = useState('');
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  const info = useQuery({
    queryKey: ['invite', token], enabled: !!token, retry: false,
    queryFn: () => papi<{ email: string; role: ClientRole; client_name: string; expires_at: string; requires_2fa: boolean }>('/invites/lookup', { method: 'POST', json: { token } }),
  });
  const accept = useMutation({ mutationFn: () => papi('/invites/accept', { method: 'POST', json: { token, name, password: pw } }) });
  const valid = name.trim().length >= 2 && pw.length >= 12 && pw === pw2;

  if (!token) return <AuthShell title="Invitación" desc="Abra el enlace completo que le compartió su administrador."><Link className="text-sm underline" to="/login">Ir al acceso</Link></AuthShell>;
  if (accept.isSuccess) {
    return (
      <AuthShell title="Cuenta creada" desc={`Ya puede entrar al portal de ${info.data?.client_name}.`}>
        <div className="grid gap-3 text-sm">
          <p className="flex items-center gap-2"><CheckCircle2 className="size-4 text-success" />Su usuario quedó activo.</p>
          {info.data?.requires_2fa && <p className="text-muted-foreground">Su rol exige verificación en dos pasos: al entrar se le pedirá activarla con una app de autenticación.</p>}
          <Button asChild><Link to="/login">Entrar</Link></Button>
        </div>
      </AuthShell>
    );
  }
  return (
    <AuthShell title="Aceptar invitación" desc={info.data ? `${info.data.client_name} le invita al portal de clientes de 856-LATAM.` : 'Verificando la invitación…'}>
      {info.isPending && <Loader2 className="mx-auto animate-spin" />}
      <ErrorBox error={info.error} />
      {info.data && (
        <form className="grid gap-4" onSubmit={(e: FormEvent) => { e.preventDefault(); accept.mutate(); }}>
          <div className="rounded-md bg-muted px-3 py-2 text-sm">
            <div><span className="text-muted-foreground">Correo:</span> <b>{info.data.email}</b></div>
            <div><span className="text-muted-foreground">Rol:</span> <b>{ROLE_LABEL[info.data.role]}</b> — {ROLE_HELP[info.data.role]}</div>
          </div>
          <Field label="Nombre completo" htmlFor="iv-name"><Input id="iv-name" autoFocus value={name} onChange={(e) => setName(e.target.value)} /></Field>
          <Field label="Contraseña" htmlFor="iv-pw" hint="Mínimo 12 caracteres. Use una frase larga que no use en otros sitios.">
            <Input id="iv-pw" type="password" autoComplete="new-password" value={pw} onChange={(e) => setPw(e.target.value)} /></Field>
          <Field label="Confirmar contraseña" htmlFor="iv-pw2"><Input id="iv-pw2" type="password" autoComplete="new-password" value={pw2} onChange={(e) => setPw2(e.target.value)} aria-invalid={pw2 !== '' && pw !== pw2} /></Field>
          <ErrorBox error={accept.error} />
          <Button type="submit" disabled={!valid || accept.isPending}>{accept.isPending && <Loader2 className="animate-spin" />}Crear mi acceso</Button>
        </form>
      )}
    </AuthShell>
  );
}
