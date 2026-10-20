import { useEffect, useState, type ReactNode } from 'react';
import {
  DndContext, KeyboardSensor, PointerSensor, closestCenter, useSensor, useSensors, type DragEndEvent,
} from '@dnd-kit/core';
import { SortableContext, arrayMove, rectSortingStrategy, sortableKeyboardCoordinates, useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { GripVertical, LayoutGrid, RotateCcw, Check } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

export type Span = 1 | 2 | 4;
export type LayoutItem = { id: string; node: ReactNode; span?: Span };
type Saved = { order: string[]; spans: Record<string, Span> };

const SPAN_CLASS: Record<Span, string> = {
  1: 'col-span-1',
  2: 'sm:col-span-2 xl:col-span-2',
  4: 'sm:col-span-2 xl:col-span-4',
};
const SPAN_LABEL: Record<Span, string> = { 1: '¼', 2: '½', 4: 'Completo' };
const NEXT: Record<Span, Span> = { 1: 2, 2: 4, 4: 1 };

function load(key: string): Saved {
  try {
    const v = JSON.parse(localStorage.getItem(key) ?? 'null');
    if (v && Array.isArray(v.order) && v.spans && typeof v.spans === 'object') return v;
  } catch { /* diseño corrupto: se usa el predeterminado */ }
  return { order: [], spans: {} };
}

/** Aplica el orden guardado; los ids nuevos van al final y los que ya no existen se descartan. */
export function applyOrder<T extends { id: string }>(items: T[], order: string[]): T[] {
  const byId = new Map(items.map((i) => [i.id, i]));
  const out: T[] = [];
  for (const id of order) { const i = byId.get(id); if (i) { out.push(i); byId.delete(id); } }
  return [...out, ...byId.values()];
}

function Tile({ item, span, editing, onSpan }: { item: LayoutItem; span: Span; editing: boolean; onSpan: () => void }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: item.id, disabled: !editing });
  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      data-layout-item={item.id}
      className={cn('relative min-w-0', SPAN_CLASS[span], editing && 'rounded-xl outline-2 outline-dashed outline-primary/40', isDragging && 'z-10 opacity-80 shadow-lg')}
    >
      {editing && (
        <div className="absolute -top-3 right-2 z-10 flex items-center gap-1 rounded-md border bg-background px-1 py-0.5 text-xs shadow-sm">
          <button type="button" className="cursor-grab touch-none p-0.5" aria-label={`Mover ${item.id}`} {...attributes} {...listeners}>
            <GripVertical className="size-4" />
          </button>
          <button type="button" className="rounded px-1.5 py-0.5 hover:bg-muted" onClick={onSpan} aria-label={`Cambiar ancho de ${item.id}`}>
            Ancho: {SPAN_LABEL[span]}
          </button>
        </div>
      )}
      <div className={cn(editing && 'pointer-events-none select-none')}>{item.node}</div>
    </div>
  );
}

/** Cuadrícula de cajas reordenables (arrastrar) y de ancho ajustable; el diseño se guarda en el navegador. */
export function LayoutGridBoard({ storageKey, items }: { storageKey: string; items: LayoutItem[] }) {
  const [saved, setSaved] = useState<Saved>(() => load(storageKey));
  const [editing, setEditing] = useState(false);
  useEffect(() => { localStorage.setItem(storageKey, JSON.stringify(saved)); }, [storageKey, saved]);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const ordered = applyOrder(items, saved.order);
  const spanOf = (i: LayoutItem): Span => saved.spans[i.id] ?? i.span ?? 4;

  const onDragEnd = (e: DragEndEvent) => {
    if (!e.over || e.active.id === e.over.id) return;
    const ids = ordered.map((i) => i.id);
    setSaved((s) => ({ ...s, order: arrayMove(ids, ids.indexOf(String(e.active.id)), ids.indexOf(String(e.over!.id))) }));
  };

  return (
    <div className="grid gap-3">
      <div className="flex justify-end gap-2">
        {editing && (
          <Button variant="ghost" size="sm" onClick={() => setSaved({ order: [], spans: {} })}>
            <RotateCcw />Restablecer
          </Button>
        )}
        <Button variant={editing ? 'default' : 'outline'} size="sm" onClick={() => setEditing((v) => !v)} aria-pressed={editing}>
          {editing ? <Check /> : <LayoutGrid />}{editing ? 'Listo' : 'Acomodar cajas'}
        </Button>
      </div>
      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
        <SortableContext items={ordered.map((i) => i.id)} strategy={rectSortingStrategy}>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
            {ordered.map((i) => (
              <Tile
                key={i.id}
                item={i}
                span={spanOf(i)}
                editing={editing}
                onSpan={() => setSaved((s) => ({ ...s, spans: { ...s.spans, [i.id]: NEXT[spanOf(i)] } }))}
              />
            ))}
          </div>
        </SortableContext>
      </DndContext>
    </div>
  );
}
