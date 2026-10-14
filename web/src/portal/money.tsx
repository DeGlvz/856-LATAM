// Piezas compartidas del portal (fase 2): montos exactos sin float, referencias y avisos.
import { Link } from 'react-router';
import { AlertTriangle, ExternalLink, Info, OctagonAlert } from 'lucide-react';
import { exactUnits, formatUnits, shortHex } from '@/lib/amount';
import { cn } from '@/lib/utils';
import { explorerFor, type Line, type Notice } from './api';

/** Monto desde unidades base (string). Muestra hasta 6 decimales; el valor exacto va en el título. */
export function Money({ v, decimals, symbol, exact, className, sign }: {
  v: string; decimals: number; symbol?: string; exact?: boolean; className?: string; sign?: '+' | '−';
}) {
  return (
    <span className={cn('num font-mono', className)} title={`${exactUnits(v, decimals)}${symbol ? ` ${symbol}` : ''}`}>
      {sign}{exact ? exactUnits(v, decimals) : formatUnits(v, decimals)}
      {symbol && <span className="ml-1 font-sans text-xs text-muted-foreground">{symbol}</span>}
    </span>
  );
}

/** Referencia propia de un movimiento: hash con enlace al explorador, o folio de retiro/corrida. */
export function RefCell({ l, network }: { l: Pick<Line, 'reference' | 'reference_type'>; network: string }) {
  if (!l.reference) return <span className="text-muted-foreground">—</span>;
  if (l.reference_type === 'tx_hash') {
    return (
      <a className="inline-flex items-center gap-1 font-mono text-xs hover:underline" href={`${explorerFor(network)}/tx/${l.reference}`}
        target="_blank" rel="noreferrer noopener" title={l.reference}>{shortHex(l.reference, 8)}<ExternalLink className="size-3" /></a>
    );
  }
  const what = l.reference_type === 'withdrawal' ? 'Retiro' : 'Corrida';
  return <span className="font-mono text-xs" title={l.reference}>{what} {l.reference.slice(0, 8)}</span>;
}

const SEV = {
  info: { icon: Info, cls: 'border-border bg-muted/50' },
  warning: { icon: AlertTriangle, cls: 'border-warning/60 bg-warning/10' },
  critical: { icon: OctagonAlert, cls: 'border-destructive/40 bg-destructive/10 text-destructive' },
} as const;
const LINK: Record<string, { to: string; text: string; admin?: boolean }> = {
  admins_below_minimum: { to: '/usuarios', text: 'Invitar a otro administrador', admin: true },
  api_key_expiring: { to: '/llaves', text: 'Rotar llave', admin: true },
  totp_disabled: { to: '/seguridad', text: 'Activar 2FA' },
};

export function NoticesBand({ notices, isAdmin }: { notices: Notice[]; isAdmin: boolean }) {
  if (!notices.length) return null;
  return (
    <ul className="grid gap-2" aria-label="Avisos">
      {notices.map((n, i) => {
        const s = SEV[n.severity] ?? SEV.info;
        const link = LINK[n.code];
        return (
          <li key={`${n.code}-${i}`} role="status" data-code={n.code} className={cn('flex flex-wrap items-start gap-2 rounded-md border px-3 py-2 text-sm', s.cls)}>
            <s.icon className="mt-0.5 size-4 shrink-0" />
            <span className="min-w-0 flex-1">{n.message}</span>
            {link && (!link.admin || isAdmin) && <Link to={link.to} className="shrink-0 font-medium underline">{link.text}</Link>}
          </li>
        );
      })}
    </ul>
  );
}

/** Mes actual en UTC (AAAA-MM) y los 12 anteriores, para el selector de estado de cuenta. */
export function lastMonths(n = 13) {
  const d = new Date();
  return Array.from({ length: n }, (_, i) => {
    const x = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - i, 1));
    const v = `${x.getUTCFullYear()}-${String(x.getUTCMonth() + 1).padStart(2, '0')}`;
    return { v, label: x.toLocaleDateString('es-MX', { month: 'long', year: 'numeric', timeZone: 'UTC' }) };
  });
}
export const fmtUtc = (iso: string) => new Date(iso).toISOString().replace('T', ' ').slice(0, 16);
