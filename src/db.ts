import pg from 'pg';
import { config } from './config.js';

// NUMERIC (1700) e INT8 (20) como string: nunca perder precisión en montos
pg.types.setTypeParser(1700, (v) => v);
pg.types.setTypeParser(20, (v) => v);

export const pool = new pg.Pool({ connectionString: config.DATABASE_URL, max: config.DB_POOL_MAX });

export type Tx = pg.PoolClient;

// Transacción con reintento (y espera aleatoria) ante conflictos de concurrencia.
// El libro usa READ COMMITTED + SELECT … FOR UPDATE en orden fijo: los saldos se leen ya bloqueados.
export async function tx<T>(
  fn: (c: Tx) => Promise<T>,
  { isolation = 'READ COMMITTED', retries = 5 }: { isolation?: 'READ COMMITTED' | 'SERIALIZABLE'; retries?: number } = {},
): Promise<T> {
  for (let i = 0; ; i++) {
    const c = await pool.connect();
    try {
      await c.query(`BEGIN ISOLATION LEVEL ${isolation}`);
      const r = await fn(c);
      await c.query('COMMIT');
      return r;
    } catch (e) {
      await c.query('ROLLBACK').catch(() => {});
      const code = (e as { code?: string }).code;
      if ((code === '40001' || code === '40P01') && i < retries) {
        await new Promise((r) => setTimeout(r, 10 * 2 ** i + Math.random() * 20));
        continue;
      }
      throw e;
    } finally {
      c.release();
    }
  }
}
