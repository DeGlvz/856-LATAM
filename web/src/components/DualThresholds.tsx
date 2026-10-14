// Fase 3 — umbral por activo a partir del cual una salida requiere DOS tesoreros distintos. Solo tesorería, con 2FA.
import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Loader2, Users } from 'lucide-react';
import { api, type Asset } from '@/lib/api';
import { exactUnits, parseUnits } from '@/lib/amount';
import { useAssets } from '@/lib/hooks';
import { Amount, CodeInput, ErrorBox, Field } from '@/components/common';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';

export function DualThresholds() {
  const qc = useQueryClient();
  const { assets, error } = useAssets();
  const [edit, setEdit] = useState<Asset | null>(null);
  const [text, setText] = useState('');
  const [code, setCode] = useState('');
  const base = edit ? (text.trim() === '' ? null : parseUnits(text, edit.decimals)) : null;
  const m = useMutation({
    mutationFn: () => api(`/assets/${edit!.id}`, { method: 'PATCH', json: { dual_treasurer_threshold: base, code } }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['assets'] }); setEdit(null); },
  });
  const list = assets.filter((a) => a.active);
  return (
    <Card data-section="dual-thresholds">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base"><Users className="size-4" />Umbral de dos tesoreros</CardTitle>
        <CardDescription>A partir de este monto, una salida de cliente necesita la autorización de dos tesoreros distintos.</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-2">
        <ErrorBox error={error} />
        {list.map((a) => (
          <div key={a.id} data-asset={a.id} className="flex flex-wrap items-center justify-between gap-2 rounded-md border px-3 py-2 text-sm">
            <span className="font-medium">{a.symbol} <span className="font-mono text-xs text-muted-foreground">{a.network}</span></span>
            <span className="text-xs">{a.dual_treasurer_threshold ? <>Desde <Amount v={a.dual_treasurer_threshold} asset={a} /></> : <span className="text-muted-foreground">Sin umbral: basta un tesorero</span>}</span>
            <Button size="sm" variant="outline" onClick={() => { setEdit(a); setText(a.dual_treasurer_threshold ? exactUnits(a.dual_treasurer_threshold, a.decimals) : ''); setCode(''); m.reset(); }}>Cambiar</Button>
          </div>
        ))}
      </CardContent>
      <Dialog open={!!edit} onOpenChange={(v) => !v && setEdit(null)}>
        <DialogContent>
          <DialogHeader><DialogTitle>Umbral de dos tesoreros · {edit?.symbol}</DialogTitle>
            <DialogDescription>Déjelo vacío para quitarlo. Aplica a las salidas que se soliciten desde ahora; queda en la bitácora.</DialogDescription></DialogHeader>
          <Field label={`Monto en ${edit?.symbol ?? ''}`} htmlFor="dual-amount">
            <Input id="dual-amount" inputMode="decimal" className="font-mono" value={text} onChange={(e) => setText(e.target.value.replace(',', '.'))} aria-invalid={text.trim() !== '' && !base} /></Field>
          <Field label="Código 2FA"><CodeInput label="Código 2FA para el umbral de dos tesoreros" value={code} onChange={setCode} /></Field>
          <ErrorBox error={m.error} />
          <DialogFooter><Button variant="outline" onClick={() => setEdit(null)}>Cancelar</Button>
            <Button disabled={code.length !== 6 || (text.trim() !== '' && !base) || m.isPending} onClick={() => m.mutate()}>{m.isPending && <Loader2 className="animate-spin" />}Guardar</Button></DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
