import * as React from 'react';
import { cn } from '@/lib/utils';

// Select nativo con estilo shadcn (accesible y sin dependencias)
function Select({ className, ...props }: React.ComponentProps<'select'>) {
  return (
    <select
      data-slot="select"
      className={cn(
        'border-input flex h-9 w-full rounded-md border bg-transparent px-3 py-1 text-sm shadow-xs outline-none disabled:cursor-not-allowed disabled:opacity-50',
        'focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px] dark:bg-input/30',
        className,
      )}
      {...props}
    />
  );
}

export { Select };
