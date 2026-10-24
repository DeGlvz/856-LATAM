import { z } from 'zod';

const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
export const WorkerPolicyInput = z.object({
  mode: z.enum(['manual', 'automatic', 'scheduled']),
  interval_minutes: z.number().int().min(5).max(525600).default(1440),
  timezone: z.literal('UTC').default('UTC'),
  windows: z.array(z.object({
    days: z.array(z.number().int().min(0).max(6)).min(1).max(7),
    start: time,
    end: z.string().regex(/^(([01]\d|2[0-3]):[0-5]\d|24:00)$/),
  }).strict().refine((w) => w.end > w.start, 'La ventana debe terminar después de iniciar (sin cruzar medianoche)'))
    .max(28).default([]),
}).strict().superRefine((p, ctx) => {
  if (p.mode === 'scheduled' && !p.windows.length) ctx.addIssue({ code: 'custom', message: 'Indique al menos una ventana' });
  for (let i = 0; i < p.windows.length; i++) {
    const a = p.windows[i];
    for (const b of p.windows.slice(i + 1)) {
      if (a.days.some((d) => b.days.includes(d)) && a.start < b.end && b.start < a.end) {
        ctx.addIssue({ code: 'custom', message: 'Las ventanas no pueden superponerse' });
      }
    }
  }
});
export type WorkerPolicy = z.infer<typeof WorkerPolicyInput>;
export const MANUAL_POLICY: WorkerPolicy = { mode: 'manual', interval_minutes: 1440, timezone: 'UTC', windows: [] };

export function currentSlot(policy: WorkerPolicy, at: Date) {
  const iso = at.toISOString(), time = iso.slice(11, 16);
  const w = policy.windows.find((w) => w.days.includes(at.getUTCDay()) && w.start <= time && time < w.end);
  return w ? `${iso.slice(0, 10)}:${w.start}:${w.end}` : null;
}
const minutes = (time: string) => Number(time.slice(0, 2)) * 60 + Number(time.slice(3));

/** Una ejecución por ventana UTC, sin catch-up fuera de ventana. */
export function nextDue(policy: WorkerPolicy, now: Date, lastSlot: string | null = null): Date | null {
  if (policy.mode === 'manual') return null;
  if (policy.mode === 'automatic') return new Date(now.getTime() + policy.interval_minutes * 60_000);
  const midnight = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  for (let offset = 0; offset <= 7; offset++) {
    const day = new Date(midnight + offset * 86400_000);
    let earliest = Infinity;
    for (const w of policy.windows) {
      if (!w.days.includes(day.getUTCDay())) continue;
      const slot = `${day.toISOString().slice(0, 10)}:${w.start}:${w.end}`;
      if (slot === lastSlot) continue;
      const candidate = Math.max(now.getTime(), day.getTime() + minutes(w.start) * 60_000);
      if (candidate < day.getTime() + minutes(w.end) * 60_000) earliest = Math.min(earliest, candidate);
    }
    if (Number.isFinite(earliest)) return new Date(earliest);
  }
  throw new Error('No se encontró próxima ventana');
}
