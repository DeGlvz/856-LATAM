import { cn } from '@/lib/utils';

// Pestañas simples controladas (el estado vive en la URL de la página)
export function Tabs<T extends string>({ value, onChange, items }: { value: T; onChange: (v: T) => void; items: { value: T; label: string; count?: number }[] }) {
  return (
    <div role="tablist" className="inline-flex h-9 w-fit items-center rounded-lg bg-muted p-1 text-muted-foreground">
      {items.map((i) => (
        <button key={i.value} role="tab" aria-selected={value === i.value} type="button" onClick={() => onChange(i.value)}
          className={cn('inline-flex h-7 items-center gap-1.5 rounded-md px-3 text-sm font-medium whitespace-nowrap transition-colors',
            value === i.value ? 'bg-background text-foreground shadow-sm' : 'hover:text-foreground')}>
          {i.label}{i.count != null && <span className="num rounded bg-muted-foreground/15 px-1.5 text-[11px]">{i.count}</span>}
        </button>
      ))}
    </div>
  );
}
