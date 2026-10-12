import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router';
import { api, type EntryRow, type PostingLine } from '@/lib/api';
import { ENTRY_KIND, useAssets } from '@/lib/hooks';
import { Amount, CopyButton, ErrorBox, fmtDate } from '@/components/common';
import { Badge } from '@/components/ui/badge';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';

type EntryDetail = Omit<EntryRow, 'postings'> & { postings: (PostingLine & { id: string })[] };

// Asiento con todas sus partidas (débitos = créditos por activo)
export function EntryDialog({ id, onClose }: { id: string | null; onClose: () => void }) {
  const { byId } = useAssets();
  const q = useQuery({ queryKey: ['entry', id], queryFn: () => api<EntryDetail>(`/entries/${id}`), enabled: !!id });
  const e = q.data;
  return (
    <Dialog open={!!id} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">Asiento {e && <Badge variant="secondary">{ENTRY_KIND[e.kind] ?? e.kind}</Badge>}</DialogTitle>
          <DialogDescription className="flex items-center gap-1 font-mono text-xs">{id}{id && <CopyButton value={id} />}</DialogDescription>
        </DialogHeader>
        <ErrorBox error={q.error} />
        {q.isPending && id && <Skeleton className="h-32" />}
        {e && (
          <div className="grid gap-4">
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
              <dt className="text-muted-foreground">Fecha</dt><dd>{fmtDate(e.created_at)}</dd>
              {e.description && <><dt className="text-muted-foreground">Descripción</dt><dd>{e.description}</dd></>}
              {e.external_ref && <><dt className="text-muted-foreground">Referencia</dt><dd className="font-mono text-xs break-all">{e.external_ref}</dd></>}
              {Object.keys(e.metadata ?? {}).length > 0 && <><dt className="text-muted-foreground">Metadatos</dt>
                <dd><pre className="max-h-32 overflow-auto rounded bg-muted p-2 text-xs">{JSON.stringify(e.metadata, null, 2)}</pre></dd></>}
            </dl>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Cuenta</TableHead>
                  <TableHead className="text-right">Débito</TableHead>
                  <TableHead className="text-right">Crédito</TableHead>
                  <TableHead className="text-right">Saldo después</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {e.postings.map((p) => {
                  const a = byId(p.asset_id);
                  return (
                    <TableRow key={p.id}>
                      <TableCell className="max-w-80">
                        <Link to={`/cuentas/${p.account_id}`} onClick={onClose} className="block truncate font-mono text-xs hover:underline" title={p.account_code}>{p.account_code}</Link>
                      </TableCell>
                      <TableCell className="text-right">{p.direction === 'debit' ? <Amount v={p.amount} asset={a} exact /> : ''}</TableCell>
                      <TableCell className="text-right">{p.direction === 'credit' ? <Amount v={p.amount} asset={a} exact /> : ''}</TableCell>
                      <TableCell className="text-right text-muted-foreground"><Amount v={p.balance_after} asset={a} symbol={false} exact /></TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
