import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { Link, Navigate } from 'react-router';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Loader2 } from 'lucide-react';
import { api, opError, type Role } from '@/lib/api';
import { ErrorBox, Field, fmtDate } from '@/components/common';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';

const ROLE_LABEL = { lectura: 'Lectura', ejecutivo: 'Ejecutivo de cuenta', tesorero: 'Tesorero' } as const;

function Shell({ title, desc, children }: { title: string; desc: string; children: ReactNode }) {
  return (
    <div className="grid min-h-dvh place-items-center bg-sidebar p-4">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <div className="mb-2 grid size-10 place-items-center rounded-lg bg-primary font-mono text-xs font-bold text-primary-foreground">856</div>
          <CardTitle className="text-lg">{title}</CardTitle>
          <CardDescription>{desc}</CardDescription>
        </CardHeader>
        <CardContent>{children}</CardContent>
      </Card>
    </div>
  );
}

// Alta de operador por enlace. El token viaja en el fragmento (#): no llega al servidor en la URL y se borra de la barra.
export function OperatorInvitation() {
  const [token] = useState(() => window.location.hash.slice(1));
  useEffect(() => { if (token) history.replaceState(null, '', window.location.pathname); }, [token]);
  const [name, setName] = useState('');
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  const info = useQuery({
    queryKey: ['operator-invite', token], enabled: !!token, retry: false, staleTime: Infinity,
    queryFn: () => api<{ email: string; role: Role; expires_at: string }>('/auth/invites/lookup', { method: 'POST', json: { token } }),
  });
  const accept = useMutation({ mutationFn: () => api('/auth/invites/accept', { method: 'POST', json: { token, name: name.trim(), password: pw } }) });
  const mismatch = pw2 !== '' && pw !== pw2;
  const valid = name.trim().length >= 2 && pw.length >= 12 && pw === pw2;

  if (!token) {
    return <Shell title="Invitación" desc="Abra el enlace completo que le compartió tesorería."><Link className="text-sm underline" to="/login">Ir al acceso</Link></Shell>;
  }
  if (accept.isSuccess) {
    return <Navigate to="/login" replace state={{ notice: `Acceso creado para ${info.data?.email ?? 'su correo'}. Entre con su contraseña; después active su 2FA en Seguridad.` }} />;
  }
  return (
    <Shell title="Aceptar invitación" desc={info.data ? 'Tesorería le invita a la consola de operación de 856-LATAM.' : 'Verificando la invitación…'}>
      {info.isPending && <Loader2 className="mx-auto animate-spin" />}
      <ErrorBox error={opError(info.error)} />
      {info.isError && <Link className="mt-3 block text-sm underline" to="/login">Ir al acceso</Link>}
      {info.data && (
        <form className="grid gap-4" onSubmit={(e: FormEvent) => { e.preventDefault(); accept.mutate(); }}>
          <div className="rounded-md bg-muted px-3 py-2 text-sm">
            <div><span className="text-muted-foreground">Correo:</span> <b className="break-all">{info.data.email}</b></div>
            <div><span className="text-muted-foreground">Rol:</span> <b>{ROLE_LABEL[info.data.role]}</b></div>
            <div className="text-xs text-muted-foreground">Vence {fmtDate(info.data.expires_at)}</div>
          </div>
          <Field label="Nombre completo" htmlFor="oi-name"><Input id="oi-name" autoFocus autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} /></Field>
          <Field label="Contraseña" htmlFor="oi-pw" hint="Mínimo 12 caracteres. Use una frase larga que no use en otros sitios.">
            <Input id="oi-pw" type="password" autoComplete="new-password" value={pw} onChange={(e) => setPw(e.target.value)} />
          </Field>
          <Field label="Confirmar contraseña" htmlFor="oi-pw2">
            <Input id="oi-pw2" type="password" autoComplete="new-password" value={pw2} onChange={(e) => setPw2(e.target.value)} aria-invalid={mismatch} />
          </Field>
          {mismatch && <p className="text-xs text-destructive">Las contraseñas no coinciden.</p>}
          <ErrorBox error={opError(accept.error)} />
          <Button type="submit" disabled={!valid || accept.isPending}>{accept.isPending && <Loader2 className="animate-spin" />}Crear mi acceso</Button>
        </form>
      )}
    </Shell>
  );
}
