// Consumos y topes de gasto: contadores propios (llamadas RPC) + presupuestos mensuales por proveedor con alertas.
import { pool } from './db.js';

type Log = { warn: (o: object, m: string) => void };

const buffer = new Map<string, number>(); // "día|proveedor|métrica" -> cantidad pendiente de guardar
const day = () => new Date().toISOString().slice(0, 10);

/** Cuenta consumo en memoria (barato); se guarda en lotes cada minuto. */
export function recordUsage(provider: string, metric: string, qty = 1) {
  const k = `${day()}|${provider}|${metric}`;
  buffer.set(k, (buffer.get(k) ?? 0) + qty);
}

export async function flushUsage() {
  if (!buffer.size) return;
  const items = [...buffer.entries()];
  buffer.clear();
  try {
    for (const [k, qty] of items) {
      const [d, provider, metric] = k.split('|');
      await pool.query(
        `INSERT INTO usage_daily (day, provider, metric, qty) VALUES ($1,$2,$3,$4)
         ON CONFLICT (day, provider, metric) DO UPDATE SET qty = usage_daily.qty + EXCLUDED.qty`, [d, provider, metric, qty]);
    }
  } catch {
    for (const [k, qty] of items) buffer.set(k, (buffer.get(k) ?? 0) + qty); // se reintenta en el siguiente lote
  }
}

export type UsageStatus = 'ok' | 'warn' | 'over' | 'none';
const lastStatus = new Map<string, UsageStatus>();

/** Guarda lo pendiente y avisa en el log una sola vez por cambio de estado (warn / over). */
export function startUsageFlush(log: Log) {
  const t = setInterval(() => {
    flushUsage()
      .then(() => usageOverview())
      .then((o) => {
        for (const p of o.providers) {
          if ((p.status === 'warn' || p.status === 'over') && lastStatus.get(p.provider) !== p.status) {
            log.warn({ provider: p.provider, used: p.used, limit: p.monthly_limit, pct: p.pct }, `consumo de ${p.label}: ${p.status === 'over' ? 'tope superado' : 'cerca del tope'}`);
          }
          lastStatus.set(p.provider, p.status);
        }
      })
      .catch(() => undefined);
  }, 60_000);
  t.unref();
  return () => clearInterval(t);
}

export interface UsageProvider {
  provider: string; label: string; unit: string; source: 'metered' | 'manual';
  monthly_limit: number | null; warn_pct: number; used: number; pct: number | null; projected: number | null; status: UsageStatus;
  manual_updated_at: string | null; manual_updated_by: string | null; notes: string | null;
  breakdown: { metric: string; qty: number }[];
}

export async function usageOverview() {
  await flushUsage(); // incluye lo que aún está en memoria
  const { rows: budgets } = await pool.query(`SELECT * FROM usage_budgets ORDER BY source DESC, label`);
  const { rows: metered } = await pool.query(
    `SELECT provider, metric, sum(qty)::float8 AS qty FROM usage_daily WHERE day >= date_trunc('month', now())::date GROUP BY provider, metric ORDER BY qty DESC`);
  const { rows: [m] } = await pool.query(
    `SELECT extract(day FROM now())::int AS d, extract(day FROM (date_trunc('month', now()) + interval '1 month - 1 day'))::int AS total`);
  const providers: UsageProvider[] = budgets.map((b) => {
    const breakdown = metered.filter((r) => r.provider === b.provider).map((r) => ({ metric: r.metric as string, qty: Number(r.qty) }));
    const used = b.source === 'metered' ? breakdown.reduce((s, r) => s + r.qty, 0) : Number(b.manual_value ?? 0);
    const limit = b.monthly_limit == null ? null : Number(b.monthly_limit);
    const pct = limit ? (used / limit) * 100 : null;
    const projected = b.source === 'metered' && m.d > 0 ? (used / m.d) * m.total : null;
    const status: UsageStatus = pct == null ? 'none' : pct >= 100 ? 'over' : pct >= b.warn_pct ? 'warn' : 'ok';
    return {
      provider: b.provider, label: b.label, unit: b.unit, source: b.source, monthly_limit: limit, warn_pct: b.warn_pct, used, pct, projected, status,
      manual_updated_at: b.manual_updated_at, manual_updated_by: b.manual_updated_by, notes: b.notes, breakdown,
    };
  });

  // Gas que paga la plataforma este mes (para valorar si conviene un gas patrocinado, p. ej. Gas Manager con recargo %)
  const { rows: gas } = await pool.query(
    `SELECT p.asset_id, s.symbol, s.decimals, sum(p.amount)::text AS spent
       FROM postings p JOIN accounts a ON a.id = p.account_id JOIN assets s ON s.id = p.asset_id
      WHERE a.code LIKE 'system:%:network_fees' AND p.direction = 'debit' AND p.created_at >= date_trunc('month', now())
      GROUP BY p.asset_id, s.symbol, s.decimals ORDER BY p.asset_id`);
  const { rows: sw } = await pool.query(
    `SELECT kind, count(*)::int AS n FROM sweeps WHERE created_at >= date_trunc('month', now()) GROUP BY kind`);
  return {
    month: new Date().toISOString().slice(0, 7),
    alerts: providers.filter((p) => p.status === 'warn' || p.status === 'over').length,
    providers,
    gas: { by_asset: gas, sweeps: Object.fromEntries(sw.map((r) => [r.kind, r.n])) },
  };
}

export async function saveBudget(by: string, provider: string, v: {
  label?: string; unit?: string; monthly_limit?: number | null; warn_pct?: number; manual_value?: number | null; notes?: string | null;
}) {
  const { rows: [cur] } = await pool.query(`SELECT * FROM usage_budgets WHERE provider = $1`, [provider]);
  if (!cur) {
    if (!v.label || !v.unit) return null; // proveedor nuevo: requiere etiqueta y unidad (siempre manual)
    await pool.query(`INSERT INTO usage_budgets (provider, label, unit, source) VALUES ($1,$2,$3,'manual')`, [provider, v.label, v.unit]);
  }
  const has = (k: keyof typeof v) => Object.prototype.hasOwnProperty.call(v, k);
  const manualChanged = has('manual_value') && cur?.source !== 'metered';
  const { rows: [row] } = await pool.query(
    `UPDATE usage_budgets SET
       label = COALESCE($2, label), unit = COALESCE($3, unit),
       monthly_limit = CASE WHEN $4 THEN $5 ELSE monthly_limit END,
       warn_pct = COALESCE($6, warn_pct),
       manual_value = CASE WHEN $7 THEN $8 ELSE manual_value END,
       manual_updated_at = CASE WHEN $7 THEN now() ELSE manual_updated_at END,
       manual_updated_by = CASE WHEN $7 THEN $9 ELSE manual_updated_by END,
       notes = CASE WHEN $10 THEN $11 ELSE notes END, updated_at = now()
     WHERE provider = $1 RETURNING *`,
    [provider, v.label ?? null, v.unit ?? null, has('monthly_limit'), v.monthly_limit ?? null, v.warn_pct ?? null,
      manualChanged, v.manual_value ?? null, by, has('notes'), v.notes ?? null]);
  return row;
}
