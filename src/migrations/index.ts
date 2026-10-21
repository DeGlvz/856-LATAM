import type { Pool } from 'pg';
import m001 from './001_ledger.js';
import m002 from './002_seed_assets.js';
import m003 from './003_compensacion.js';
import m004 from './004_transferencias.js';
import m005 from './005_depositos_barrido.js';
import m006 from './006_consola.js';
import m007 from './007_clientes_estado.js';
import m008 from './008_compensacion_consola.js';
import m009 from './009_aprobaciones_2fa.js';
import m010 from './010_gas_bump.js';
import m011 from './011_portal_identidad.js';
import m012 from './012_consola_operadores.js';
import m013 from './013_portal_salidas.js';
import m014 from './014_portal_obligaciones.js';
import m015 from './015_multired.js';
import m016 from './016_fiat_entrada.js';
import m017 from './017_fiat_per_client.js';
import m018 from './018_client_assistance.js';
import m019 from './019_deposit_wallet_archive.js';
import m020 from './020_portal_user_deletion.js';
import m021 from './021_client_retirement.js';
import m022 from './022_client_password_resets.js';
import m023 from './023_openfort_events.js';
import m024 from './024_fiat_rails.js';
import m025 from './025_fiat_rails_archive.js';
import m026 from './026_fiat_rails_delete.js';
import m027 from './027_fiat_rails_holder_type.js';
import m028 from './028_fiat_remove_transak.js';
import m029 from './029_fiat_rails_cleanup.js';
import m030 from './030_fiat_intent_report.js';
import m031 from './031_client_config_drafts.js';
import m032 from './032_operator_access_links.js';

// Migraciones embebidas en el build (no hay archivos .sql que copiar al contenedor).
// Nunca editar una ya aplicada: agregar una nueva.
const migrations: [string, string][] = [
  ['001_ledger', m001],
  ['002_seed_assets', m002],
  ['003_compensacion', m003],
  ['004_transferencias', m004],
  ['005_depositos_barrido', m005],
  ['006_consola', m006],
  ['007_clientes_estado', m007],
  ['008_compensacion_consola', m008],
  ['009_aprobaciones_2fa', m009],
  ['010_gas_bump', m010],
  ['011_portal_identidad', m011],
  ['012_consola_operadores', m012],
  ['013_portal_salidas', m013],
  ['014_portal_obligaciones', m014],
  ['015_multired', m015],
  ['016_fiat_entrada', m016],
  ['017_fiat_per_client', m017],
  ['018_client_assistance', m018],
  ['019_deposit_wallet_archive', m019],
  ['020_portal_user_deletion', m020],
  ['021_client_retirement', m021],
  ['022_client_password_resets', m022],
  ['023_openfort_events', m023],
  ['024_fiat_rails', m024],
  ['025_fiat_rails_archive', m025],
  ['026_fiat_rails_delete', m026],
  ['027_fiat_rails_holder_type', m027],
  ['028_fiat_remove_transak', m028],
  ['029_fiat_rails_cleanup', m029],
  ['030_fiat_intent_report', m030],
  ['031_client_config_drafts', m031],
  ['032_operator_access_links', m032],
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
