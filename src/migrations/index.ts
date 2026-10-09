import type { Pool } from 'pg';
import m001 from './001_ledger.js';
import m002 from './002_seed_assets.js';

// Migraciones embebidas en el build (no hay archivos .sql que copiar al contenedor).
// Nunca editar una ya aplicada: agregar una nueva.
const migrations: [string, string][] = [
  ['001_ledger', m001],
  ['002_seed_assets', m002],
];

export async function migrate(pool: Pool, log: (msg: string) => void = console.log) {
  const c = await pool.connect();
  try {
    await c.query('SELECT pg_advisory_lock(856001)'); // una sola réplica migra a la vez
    await c.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      id TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
    const { rows } = await c.query<{ id: string }>('SELECT id FROM schema_migrations');
    const done = new Set(rows.map((r) => r.id));
    for (const [id, sql] of migrations) {
      if (done.has(id)) continue;
      await c.query('BEGIN');
      try {
        await c.query(sql);
        await c.query('INSERT INTO schema_migrations (id) VALUES ($1)', [id]);
        await c.query('COMMIT');
        log(`migración aplicada: ${id}`);
      } catch (e) {
        await c.query('ROLLBACK');
        throw e;
      }
    }
  } finally {
    await c.query('SELECT pg_advisory_unlock(856001)').catch(() => {});
    c.release();
  }
}
