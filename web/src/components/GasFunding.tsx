// Registro de gas en el libro: el tesorero registra con 2FA la transacción con la que fondeó la hot wallet.
// El servidor verifica en cadena destino, origen y confirmaciones, y toma el monto de la propia transacción.
import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ExternalLink } from 'lucide-react';
import { api } from '@/lib/api';
import { formatUnits, exactUnits } from '@/lib/amount';
import { useNetworks } from '@/lib/hooks';
import { Field, fmtDate } from '@/components/common';
import { StepUpDialog } from '@/components/StepUpDialog';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';

export interface GasFunding { id: string; created_at: string; tx_hash: string; network: string; from_address: string; registered_by: string; asset_id: string; amount: string; decimals: number }

export function GasFundingDialog({ open, network, onClose }: { open: boolean; network?: string; onClose: () => void }) {
  const qc = useQueryClient();
  const { networks, label } = useNetworks();
  const [net, setNet] = useState(network ?? '');
  const [hash, setHash] = useState('');
  useEffect(() => { if (open) { setNet(network ?? networks[0]?.id ?? ''); setHash(''); } }, [open, network]); // eslint-disable-line react-hooks/exhaustive-deps
  const valid = !!net && /^0x[0-9a-fA-F]{64}$/.test(hash.trim());
  return (
    <StepUpDialog<GasFunding> open={open} title="Registrar fondeo de gas" confirmLabel="Registrar" canSubmit={valid} keepOpen
      description="Pegue el hash de la transacción con la que envió moneda nativa a la hot wallet. Se verifica en cadena y el monto se toma de la transacción; queda como aportación de 856 (custodia / patrimonio)."
      onConfirm={(code) => api<GasFunding>('/gas-fundings', { method: 'POST', json: { network: net, tx_hash: hash.trim(), code } })
        .then((r) => { qc.invalidateQueries({ queryKey: ['summary'] }); qc.invalidateQueries({ queryKey: ['gas-fundings'] }); return r; })}
      result={(r) => <p data-testid="gas-registered">Registrado: <b className="num">{exactUnits(r.amount, r.decimals)} {r.asset_id}</b> en {label(r.network)}. Los barridos y retiros detenidos se liquidan en el siguiente ciclo del worker.</p>}
      onClose={onClose}>
      <Field label="Red" htmlFor="gf-net">
        <Select id="gf-net" aria-label="Red del fondeo" value={net} onChange={(e) => setNet(e.target.value)}>
          {networks.map((n) => <option key={n.id} value={n.id}>{n.label}</option>)}
        </Select></Field>
      <Field label="Hash de la transacción" htmlFor="gf-hash" hint="0x seguido de 64 caracteres; la transacción debe tener las confirmaciones de la red.">
        <Input id="gf-hash" className="font-mono text-xs" placeholder="0x…" value={hash} onChange={(e) => setHash(e.target.value)} aria-invalid={hash !== '' && !valid} /></Field>
    </StepUpDialog>
  );
}

export function GasFundingsTable() {
  const { label, explorer } = useNetworks();
  const q = useQuery({ queryKey: ['gas-fundings'], queryFn: () => api<{ items: GasFunding[] }>('/gas-fundings') });
  return (
    <Card className="py-2"><CardContent className="px-3">
      {q.isPending ? <Skeleton className="h-24" /> : (
        <div className="overflow-x-auto">
          <Table aria-label="Fondeos de gas registrados">
            <TableHeader><TableRow><TableHead>Registrado</TableHead><TableHead>Red</TableHead><TableHead className="text-right">Monto</TableHead><TableHead>Transacción</TableHead><TableHead>Origen</TableHead><TableHead>Quién</TableHead></TableRow></TableHeader>
            <TableBody>
              {!q.data?.items.length && <TableRow><TableCell colSpan={6} className="py-8 text-center text-muted-foreground">Sin fondeos de gas registrados.</TableCell></TableRow>}
              {q.data?.items.map((g) => (
                <TableRow key={g.id} data-gas-funding={g.tx_hash}>
                  <TableCell className="text-xs whitespace-nowrap">{fmtDate(g.created_at)}</TableCell>
                  <TableCell className="text-sm">{label(g.network)}</TableCell>
                  <TableCell className="num text-right" title={exactUnits(g.amount, g.decimals)}>{formatUnits(g.amount, g.decimals, 6)} <span className="text-muted-foreground">{g.asset_id}</span></TableCell>
                  <TableCell><a className="inline-flex items-center gap-1 font-mono text-xs text-primary" href={`${explorer(g.network)}/tx/${g.tx_hash}`} target="_blank" rel="noreferrer noopener">{g.tx_hash.slice(0, 10)}…<ExternalLink className="size-3" /></a></TableCell>
                  <TableCell className="font-mono text-xs">{g.from_address.slice(0, 10)}…</TableCell>
                  <TableCell className="text-xs">{g.registered_by}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </CardContent></Card>
  );
}
