import { useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Check, Loader2, ShieldAlert, X } from 'lucide-react';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { ErrorBox } from '@/components/common';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

const REFRESH = ['approvals', 'summary', 'withdrawals', 'withdrawal', 'netting-runs', 'netting-run', 'obligations', 'client', 'entries'];

/**
 * Autorizar (con código 2FA) o rechazar (con motivo) un retiro o una corrida pendiente.
 * Quien solicitó un retiro no puede autorizarlo.
 */
export function ApprovalPanel({ kind, id, requestedByOperator, requestedBy, onDone, compact, exit }: {
  kind: 'withdrawal' | 'run'; id: string; requestedByOperator: string | null; requestedBy?: string | null;
  onDone?: () => void; compact?: boolean;
  /** Fase 3: salida originada por el cliente (la consola valida y autoriza; el texto cambia). */
  exit?: boolean;
}) {
  const { operator, can } = useAuth();
  const qc = useQueryClient();
  const [code, setCode] = useState('');
  const [reason, setReason] = useState('');
  const [rejecting, setRejecting] = useState(false);
  const base = kind === 'withdrawal' ? `/withdrawals/${id}` : `/netting/runs/${id}`;
  const after = () => { REFRESH.forEach((k) => qc.invalidateQueries({ queryKey: [k] })); setCode(''); setReason(''); setRejecting(false); onDone?.(); };
  const approve = useMutation({ mutationFn: () => api(`${base}/approve`, { method: 'POST', json: { code } }), onSuccess: after });
  const reject = useMutation({ mutationFn: () => api(`${base}/reject`, { method: 'POST', json: { reason: reason.trim() } }), onSuccess: after });

  if (!can('ejecutivo')) return <p className="text-sm text-muted-foreground">Pendiente de autorización por un ejecutivo de cuenta o tesorero.</p>;
  const own = !!operator && requestedByOperator === operator.id;
  const label = exit ? 'salida' : kind === 'withdrawal' ? 'retiro' : 'corrida';
  const art = exit ? 'la salida' : kind === 'withdrawal' ? 'el retiro' : 'la corrida';
  const approveText = exit ? 'Autorizar salida' : `Aprobar ${label}`;

  return (
    <div className="grid gap-3 rounded-md border border-warning/60 bg-warning/5 p-3 text-sm">
      {!compact && (
        <div className="flex items-start gap-2">
          <ShieldAlert className="mt-0.5 size-4 shrink-0" />
          <p>Solicitado por <b>{requestedBy ?? '—'}</b>. Un ejecutivo de cuenta o tesorero distinto debe autorizarlo con 2FA.</p>
        </div>
      )}
      {own ? (
        <p className="text-muted-foreground">Usted lo solicitó: no puede aprobarlo. Puede rechazarlo si ya no procede.</p>
      ) : !operator?.totp_enabled ? (
        <p>Para aprobar necesita el 2FA activo. <Link to="/seguridad" className="font-medium underline">Activarlo en Seguridad</Link>.</p>
      ) : !rejecting && (
        <form className="flex flex-wrap items-center gap-2" onSubmit={(e: FormEvent) => { e.preventDefault(); approve.mutate(); }}>
          <Input aria-label={`Código 2FA para aprobar ${art}`} inputMode="numeric" autoComplete="one-time-code" maxLength={6} placeholder="Código 2FA"
            className="h-9 w-36 text-center font-mono tracking-widest" value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} />
          <Button type="submit" size="sm" className="h-9" disabled={code.length !== 6 || approve.isPending}>
            {approve.isPending ? <Loader2 className="animate-spin" /> : <Check />}{approveText}
          </Button>
        </form>
      )}
      {rejecting ? (
        <form className="grid gap-2" onSubmit={(e: FormEvent) => { e.preventDefault(); reject.mutate(); }}>
          <Input aria-label="Motivo del rechazo" autoFocus maxLength={300} placeholder="Motivo del rechazo (mín. 5 caracteres)" value={reason} onChange={(e) => setReason(e.target.value)} />
          <div className="flex gap-2">
            <Button type="button" size="sm" variant="outline" onClick={() => setRejecting(false)}>Volver</Button>
            <Button type="submit" size="sm" variant="destructive" disabled={reason.trim().length < 5 || reject.isPending}>
              {reject.isPending ? <Loader2 className="animate-spin" /> : <X />}Rechazar {label}
            </Button>
          </div>
        </form>
      ) : (
        <div><Button type="button" size="sm" variant="ghost" className="h-7 px-2 text-destructive" onClick={() => setRejecting(true)}><X />Rechazar…</Button></div>
      )}
      <ErrorBox error={approve.error ?? reject.error} />
    </div>
  );
}
