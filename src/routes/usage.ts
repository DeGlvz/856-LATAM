// Consola: consumos y topes de gasto por proveedor (solo tesorería). Alertas en el tablero y en el menú.
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit } from '../auth/operators.js';
import { HttpError } from '../idempotency.js';
import { saveBudget, usageOverview } from '../usage.js';

const Body = z.object({
  label: z.string().trim().min(2).max(60).optional(),
  unit: z.string().trim().min(1).max(20).optional(),
  monthly_limit: z.number().positive().max(1e15).nullable().optional(),
  warn_pct: z.number().int().min(1).max(100).optional(),
  manual_value: z.number().min(0).max(1e15).nullable().optional(),
  notes: z.string().trim().max(500).nullable().optional(),
}).refine((v) => Object.keys(v).length > 0, 'Sin cambios');

export async function usageRoutes(app: FastifyInstance) {
  app.get('/usage', async () => usageOverview());

  app.put<{ Params: { provider: string } }>('/usage/:provider', async (req) => {
    const provider = z.string().regex(/^[a-z0-9_-]{2,40}$/, 'proveedor inválido (minúsculas, números, - y _)').safeParse(req.params.provider);
    if (!provider.success) throw new HttpError(400, provider.error.issues[0].message, 'validation_error');
    const b = Body.safeParse(req.body ?? {});
    if (!b.success) throw new HttpError(400, b.error.issues.map((i) => `${i.path.join('.') || 'cuerpo'}: ${i.message}`).join('; '), 'validation_error');
    const p = req.principal;
    const by = p?.kind === 'operator' ? p.operator.email : 'api';
    const row = await saveBudget(by, provider.data, b.data);
    if (!row) throw new HttpError(422, 'Proveedor nuevo: indique label y unit', 'validation_error');
    await audit({ operator_id: p?.kind === 'operator' ? p.operator.id : null, actor: `operador:${by}`, action: 'usage_budget_updated', target: provider.data,
      status: 200, ip: req.ip, metadata: { ...b.data } });
    return row;
  });
}
