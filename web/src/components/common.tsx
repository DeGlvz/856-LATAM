import { useState } from 'react';
import { Check, Copy, XCircle } from 'lucide-react';
import type { Asset, ClientStatus } from '@/lib/api';
import { exactUnits, formatUnits } from '@/lib/amount';
import { CLIENT_STATUS } from '@/lib/hooks';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';

export function CopyButton({ value, className }: { value: string; className?: string }) {
  const [done, setDone] = useState(false);
  return (
    <button type="button" title="Copiar" aria-label="Copiar"
      className={cn('inline-flex size-6 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground', className)}
      onClick={() => navigator.clipboard?.writeText(value).then(() => { setDone(true); setTimeout(() => setDone(false), 1200); })}>
      {done ? <Check className="size-3.5 text-success" /> : <Copy className="size-3.5" />}
    </button>
  );
}

export function StatusBadge({ status }: { status: ClientStatus }) {
  const s = CLIENT_STATUS[status];
  return <Badge variant={s.variant}>{s.label}</Badge>;
}

export function Amount({ v, asset, symbol = true, exact = false, className }: { v: string | null | undefined; asset: Asset; symbol?: boolean; exact?: boolean; className?: string }) {
  return (
    <span className={cn('num font-mono text-[13px]', className)} title={v != null ? `${exactUnits(v, asset.decimals)} ${asset.symbol} (${v} unidades base)` : undefined}>
      {exact ? exactUnits(v, asset.decimals) : formatUnits(v, asset.decimals)}{symbol && <span className="ml-1 font-sans text-xs text-muted-foreground">{asset.symbol}</span>}
    </span>
  );
}

export function ErrorBox({ error, className }: { error: unknown; className?: string }) {
  if (!error) return null;
  return (
    <div role="alert" className={cn('flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive', className)}>
      <XCircle className="mt-0.5 size-4 shrink-0" /><span>{error instanceof Error ? error.message : String(error)}</span>
    </div>
  );
}

export function Field({ label, htmlFor, hint, children }: { label: string; htmlFor?: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="grid gap-1.5">
      <label htmlFor={htmlFor} className="text-sm font-medium">{label}</label>
      {children}
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

export const fmtDate = (iso: string) => new Date(iso).toLocaleString('es-MX', { dateStyle: 'short', timeStyle: 'short' });
