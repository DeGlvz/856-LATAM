import { useEffect, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, CheckCircle2, Download, KeyRound, Loader2, Plus, RefreshCw, X } from 'lucide-react';
import { papi, type KeyRow } from '../api';
import { download, ed25519Supported, encryptPrivate, newEd25519, publicRaw, signProof } from '../crypto';
import { CodeInput } from './Security';
import { CopyButton, ErrorBox, Field, fmtDate } from '@/components/common';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';

const state = (k: KeyRow) => k.revoked_at ? { t: 'Revocada', v: 'outline' as const }
  : new Date(k.expires_at) <= new Date() ? { t: 'Vencida', v: 'outline' as const }
  : k.locked_until && new Date(k.locked_until) > new Date() ? { t: 'Bloqueada', v: 'destructive' as const }
  : { t: 'Activa', v: 'success' as const };

export function Keys() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['p-keys'], queryFn: () => papi<{ keys: KeyRow[]; max_days: number }>('/keys') });
  const revoke = useMutation({ mutationFn: (id: string) => papi(`/keys/${id}/revoke`, { method: 'POST', json: {} }), onSuccess: () => qc.invalidateQueries({ queryKey: ['p-keys'] }) });
  const [creating, setCreating] = useState(false);
  const [rotating, setRotating] = useState<KeyRow | null>(null);
  const [confirmRevoke, setConfirmRevoke] = useState<KeyRow | null>(null);

  return (
    <div className="mx-auto grid max-w-6xl grid-cols-[minmax(0,1fr)] gap-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Llaves de API</h1>
          <p className="text-sm text-muted-foreground">Para que el ERP o la tesorería de su empresa se conecten. Las fabrica el sistema; 856 nunca conoce su llave privada.</p>
        </div>
        <Button onClick={() => setCreating(true)}><Plus />Nueva llave</Button>
      </div>
      <ErrorBox error={q.error ?? revoke.error} />
      <Card className="py-2"><CardContent className="px-3">
        <Table>
          <TableHeader><TableRow><TableHead>Llave</TableHead><TableHead>Tipo y permisos</TableHead><TableHead>IP</TableHead><TableHead>Vence</TableHead><TableHead>Último uso</TableHead><TableHead>Estado</TableHead><TableHead /></TableRow></TableHeader>
          <TableBody>
            {!q.isPending && !q.data?.keys.length && <TableRow><TableCell colSpan={7} className="py-8 text-center text-muted-foreground">Aún no hay llaves.</TableCell></TableRow>}
            {q.data?.keys.map((k) => {
              const s = state(k);
              const live = s.t === 'Activa' || s.t === 'Bloqueada';
              return (
                <TableRow key={k.id} className={live ? undefined : 'opacity-60'}>
                  <TableCell><div className="text-sm font-medium">{k.name}</div><div className="font-mono text-xs text-muted-foreground">{k.prefix}</div></TableCell>
                  <TableCell className="text-xs"><Badge variant="outline">{k.kind === 'ed25519' ? 'Firma Ed25519' : 'Token de lectura'}</Badge> <span className="text-muted-foreground">{k.permissions.join(', ')}</span></TableCell>
                  <TableCell className="max-w-40 truncate font-mono text-xs" title={k.ip_allowlist.join(', ')}>{k.ip_allowlist.length ? k.ip_allowlist.join(', ') : 'Cualquiera'}</TableCell>
                  <TableCell className="text-xs">{fmtDate(k.expires_at)}</TableCell>
                  <TableCell className="text-xs text-muted-foreground">{k.last_used_at ? `${fmtDate(k.last_used_at)} · ${k.last_used_ip}` : 'Nunca'}</TableCell>
                  <TableCell><Badge variant={s.v}>{s.t}</Badge></TableCell>
                  <TableCell className="text-right whitespace-nowrap">
                    {live && <Button size="sm" variant="ghost" onClick={() => setRotating(k)}><RefreshCw />Rotar</Button>}
                    {live && <Button size="sm" variant="ghost" className="text-destructive" onClick={() => setConfirmRevoke(k)}><X />Revocar</Button>}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </CardContent></Card>
      <IntegrationHelp />
      <KeyDialog open={creating} onClose={() => setCreating(false)} maxDays={q.data?.max_days ?? 90} />
      <KeyDialog open={!!rotating} rotate={rotating} onClose={() => setRotating(null)} maxDays={q.data?.max_days ?? 90} />
      <Dialog open={!!confirmRevoke} onOpenChange={(v) => !v && setConfirmRevoke(null)}>
        <DialogContent>
          <DialogHeader><DialogTitle>Revocar {confirmRevoke?.prefix}</DialogTitle>
            <DialogDescription>Deja de funcionar al instante. Cualquier integración que la use quedará desconectada.</DialogDescription></DialogHeader>
          <DialogFooter><Button variant="outline" onClick={() => setConfirmRevoke(null)}>Cancelar</Button>
            <Button variant="destructive" onClick={() => { revoke.mutate(confirmRevoke!.id); setConfirmRevoke(null); }}>Revocar</Button></DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ───────────── Alta / rotación ─────────────
function KeyDialog({ open, onClose, rotate, maxDays }: { open: boolean; onClose: () => void; rotate?: KeyRow | null; maxDays: number }) {
  const qc = useQueryClient();
  const [name, setName] = useState('');
  const [kind, setKind] = useState<'ed25519' | 'read_token'>('ed25519');
  const [ips, setIps] = useState('');
  const [days, setDays] = useState(String(maxDays));
  const [pass, setPass] = useState('');
  const [pass2, setPass2] = useState('');
  const [code, setCode] = useState('');
  const [withdraw, setWithdraw] = useState(false);
  const [supported, setSupported] = useState<boolean | null>(null);
  const [result, setResult] = useState<{ prefix: string; token?: string; file?: boolean } | null>(null);
  useEffect(() => {
    if (!open) return;
    setName(''); setIps(''); setDays(String(maxDays)); setPass(''); setPass2(''); setCode(''); setResult(null); setWithdraw(false);
    setKind(rotate?.kind ?? 'ed25519');
    ed25519Supported().then(setSupported);
  }, [open, rotate, maxDays]);
  const ed = kind === 'ed25519';

  const m = useMutation({
    mutationFn: async () => {
      const common = {
        ...(rotate ? {} : { name: name.trim(), kind, ...(kind === 'ed25519' && withdraw ? { permissions: ['read', 'withdraw'] } : {}) }),
        ...(ips.trim() ? { ip_allowlist: ips.split(/[\s,]+/).filter(Boolean) } : {}),
        expires_days: Number(days), code,
      };
      if (!ed) {
        const r = await papi<{ prefix: string; token: string }>(rotate ? `/keys/${rotate.id}/rotate` : '/keys', { method: 'POST', json: common });
        return { prefix: r.prefix, token: r.token };
      }
      // Par Ed25519 en este navegador → prueba de posesión → solo la pública viaja a 856
      const pair = await newEd25519();
      const ch = await papi<{ challenge: string; message: string }>('/keys/challenge', { method: 'POST', json: {} });
      const body = { ...common, public_key: await publicRaw(pair), challenge: ch.challenge, proof: await signProof(pair, ch.message) };
      const r = await papi<{ prefix: string }>(rotate ? `/keys/${rotate.id}/rotate` : '/keys', { method: 'POST', json: body });
      download(`856-llave-${r.prefix}.json`, await encryptPrivate(pair, pass, r.prefix)); // única entrega, cifrada con su frase
      return { prefix: r.prefix, file: true };
    },
    onSuccess: (r) => { setResult(r); qc.invalidateQueries({ queryKey: ['p-keys'] }); },
  });
  const ready = (rotate || name.trim().length >= 2) && code.length === 6 && Number(days) >= 1 && Number(days) <= maxDays
    && (!ed || (supported && pass.length >= 12 && pass === pass2));

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{rotate ? `Rotar ${rotate.prefix}` : 'Nueva llave de API'}</DialogTitle>
          <DialogDescription>{rotate ? 'Se crea una llave nueva; la anterior sigue funcionando unos días para que cambie su integración sin cortes.' : 'El sistema define el algoritmo y la longitud. Usted no elige ni escribe la llave.'}</DialogDescription>
        </DialogHeader>
        {result ? (
          <div className="grid gap-3 text-sm">
            <p className="flex items-center gap-2 font-medium"><CheckCircle2 className="size-4 text-success" />Llave {result.prefix} creada.</p>
            {result.file && <p>Se descargó <b className="font-mono">856-llave-{result.prefix}.json</b>: su llave privada cifrada con la frase que eligió. 856 no la conserva; si la pierde, genere otra.</p>}
            {result.token && (
              <div className="grid gap-2 rounded-md border border-warning/60 bg-warning/10 p-3">
                <p className="flex items-center gap-2 font-medium"><AlertTriangle className="size-4" />Copie el token ahora: no se volverá a mostrar.</p>
                <div className="flex items-center gap-1 rounded bg-background px-2 py-1.5 font-mono text-xs break-all">{result.token}<CopyButton value={result.token} /></div>
              </div>
            )}
            <DialogFooter><Button onClick={onClose}>Listo</Button></DialogFooter>
          </div>
        ) : (
          <form className="grid gap-4" onSubmit={(e: FormEvent) => { e.preventDefault(); m.mutate(); }}>
            {!rotate && (
              <>
                <Field label="Nombre" htmlFor="k-name" hint="Para reconocerla, p. ej. «ERP SAP producción»."><Input id="k-name" autoFocus value={name} onChange={(e) => setName(e.target.value)} /></Field>
                <div className="grid gap-2 sm:grid-cols-2" role="radiogroup" aria-label="Tipo de llave">
                  {([['ed25519', 'Firma Ed25519 (recomendada)', 'Cada petición va firmada. La privada se genera en este navegador y solo usted la tiene.'],
                    ['read_token', 'Token de solo lectura', 'Para tableros o BI. Solo consulta; 856 guarda únicamente su huella.']] as const).map(([v, t, d]) => (
                    <button key={v} type="button" role="radio" aria-checked={kind === v} onClick={() => setKind(v)}
                      className={cn('rounded-md border p-3 text-left text-sm', kind === v ? 'border-primary bg-primary/5 ring-1 ring-primary' : 'hover:bg-accent')}>
                      <div className="font-medium">{t}</div><div className="text-xs text-muted-foreground">{d}</div>
                    </button>
                  ))}
                </div>
              </>
            )}
            {!rotate && ed && (
              <label className="flex items-start gap-2 rounded-md border p-3 text-sm">
                <input type="checkbox" className="mt-1" checked={withdraw} onChange={(e) => setWithdraw(e.target.checked)} aria-label="Permitir originar salidas" />
                <span><span className="font-medium">Permitir originar salidas</span><span className="block text-xs text-muted-foreground">La llave podrá simular, solicitar y cancelar salidas a su lista blanca. Igual pasan por su aprobación interna (si supera el umbral) y por la autorización de 856.</span></span>
              </label>
            )}
            {ed && supported === false && <ErrorBox error="Este navegador no soporta Ed25519 en WebCrypto. Use una versión reciente de Chrome, Edge, Firefox o Safari." />}
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Vigencia (días)" htmlFor="k-days" hint={`Máximo ${maxDays}. Recibirá aviso para rotarla.`}>
                <Input id="k-days" inputMode="numeric" value={days} onChange={(e) => setDays(e.target.value.replace(/\D/g, ''))} /></Field>
              <Field label="IP autorizadas (opcional)" htmlFor="k-ips" hint="Una por línea o separadas por coma; admite rangos /24.">
                <Textarea id="k-ips" rows={2} className="font-mono text-xs" placeholder={rotate?.ip_allowlist.join('\n') || '203.0.113.10\n198.51.100.0/24'} value={ips} onChange={(e) => setIps(e.target.value)} /></Field>
            </div>
            {ed && (
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Frase para cifrar la llave privada" htmlFor="k-pass" hint="Mínimo 12 caracteres. La necesitará su servidor para usarla.">
                  <Input id="k-pass" type="password" autoComplete="new-password" value={pass} onChange={(e) => setPass(e.target.value)} /></Field>
                <Field label="Confirmar frase" htmlFor="k-pass2"><Input id="k-pass2" type="password" autoComplete="new-password" value={pass2} onChange={(e) => setPass2(e.target.value)} aria-invalid={pass2 !== '' && pass !== pass2} /></Field>
              </div>
            )}
            <Field label="Confirme con su código 2FA"><CodeInput label="Código 2FA para la llave" value={code} onChange={setCode} /></Field>
            <ErrorBox error={m.error} />
            <DialogFooter>
              <Button type="button" variant="outline" onClick={onClose}>Cancelar</Button>
              <Button type="submit" disabled={!ready || m.isPending}>{m.isPending ? <Loader2 className="animate-spin" /> : ed ? <Download /> : <KeyRound />}
                {ed ? 'Generar y descargar' : 'Generar token'}</Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}

function IntegrationHelp() {
  const snippet = `// Firma de cada petición (Node.js 20+)
import { createHash, sign } from 'node:crypto';
const ts = Math.floor(Date.now() / 1000).toString();
const nonce = crypto.randomUUID().replaceAll('-', '');
const body = '';                       // cuerpo JSON exacto que enviará ('' en GET)
const msg = ['GET', '/v1/portal/ping', ts, nonce, createHash('sha256').update(body).digest('hex')].join('\\n');
const signature = sign(null, Buffer.from(msg), privateKey).toString('base64url');
// Headers: x-856-key: <prefijo>  x-856-timestamp: ts  x-856-nonce: nonce  x-856-signature: signature`;
  return (
    <Card>
      <CardHeader><CardTitle className="text-base">Cómo firmar las peticiones</CardTitle>
        <CardDescription>Ventana de 5 minutos y nonce irrepetible. Diez firmas inválidas bloquean la llave 15 minutos. Con permiso de lectura, las llaves consultan por GET: /balances, /activity, /accounts/:activo/entries(.csv), /statements/:AAAA-MM, /deposit-addresses, /deposits y /notices.</CardDescription></CardHeader>
      <CardContent><pre className="overflow-x-auto rounded-md bg-muted p-3 text-xs leading-relaxed">{snippet}</pre></CardContent>
    </Card>
  );
}
