import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { useMutation } from '@tanstack/react-query';
import { Loader2, ShieldCheck } from 'lucide-react';
import { opError } from '@/lib/api';
import { CodeInput, ErrorBox } from '@/components/common';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';

/**
 * Confirmación con step-up: pide un código 2FA vigente del operador que actúa antes de ejecutar `onConfirm(code)`.
 * `children` permite añadir campos propios (p. ej. correo y rol de una invitación) encima del código.
 * Si `onConfirm` resuelve, el diálogo se cierra salvo que `keepOpen` sea verdadero (para mostrar un resultado).
 */
export function StepUpDialog<T>({ open, title, description, confirmLabel, destructive, canSubmit = true, keepOpen, children, result, onConfirm, onClose }: {
  open: boolean; title: string; description?: ReactNode; confirmLabel: string; destructive?: boolean; canSubmit?: boolean; keepOpen?: boolean;
  children?: ReactNode; result?: (r: T) => ReactNode; onConfirm: (code: string) => Promise<T>; onClose: () => void;
}) {
  const [code, setCode] = useState('');
  const m = useMutation({ mutationFn: (c: string) => onConfirm(c), onSuccess: () => { setCode(''); if (!keepOpen) onClose(); }, onError: () => setCode('') });
  useEffect(() => { if (open) { setCode(''); m.reset(); } }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
  const done = keepOpen && m.isSuccess && result;
  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description && <DialogDescription>{description}</DialogDescription>}
        </DialogHeader>
        {done ? (
          <div className="grid gap-3 text-sm">
            {result(m.data as T)}
            <DialogFooter><Button onClick={onClose}>Listo</Button></DialogFooter>
          </div>
        ) : (
          <form className="grid gap-4" onSubmit={(e: FormEvent) => { e.preventDefault(); m.mutate(code); }}>
            {children}
            <div className="grid gap-1.5">
              <label className="flex items-center gap-1.5 text-sm font-medium"><ShieldCheck className="size-4" />Código 2FA para confirmar</label>
              <CodeInput label="Código 2FA para confirmar" value={code} onChange={setCode} autoFocus={!children} />
              <p className="text-xs text-muted-foreground">Cada código sirve una sola vez; si falla, espere al siguiente.</p>
            </div>
            <ErrorBox error={opError(m.error)} />
            <DialogFooter>
              <Button type="button" variant="outline" onClick={onClose}>Cancelar</Button>
              <Button type="submit" variant={destructive ? 'destructive' : 'default'} disabled={!canSubmit || code.length !== 6 || m.isPending}>
                {m.isPending && <Loader2 className="animate-spin" />}{confirmLabel}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
