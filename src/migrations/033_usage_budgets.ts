// 033 - Consumos y topes de gasto: contadores diarios propios (llamadas RPC) y presupuesto mensual por proveedor
// (medido por nosotros o capturado a mano). Idempotente.
export default /* sql */ `
CREATE TABLE IF NOT EXISTS usage_daily (
  day      DATE NOT NULL,
  provider TEXT NOT NULL,
  metric   TEXT NOT NULL,
  qty      NUMERIC NOT NULL DEFAULT 0,
  PRIMARY KEY (day, provider, metric)
);

CREATE TABLE IF NOT EXISTS usage_budgets (
  provider          TEXT PRIMARY KEY CHECK (provider ~ '^[a-z0-9_-]{2,40}$'),
  label             TEXT NOT NULL,
  unit              TEXT NOT NULL,
  source            TEXT NOT NULL CHECK (source IN ('metered','manual')),
  monthly_limit     NUMERIC CHECK (monthly_limit IS NULL OR monthly_limit > 0),
  warn_pct          INT NOT NULL DEFAULT 80 CHECK (warn_pct BETWEEN 1 AND 100),
  manual_value      NUMERIC CHECK (manual_value IS NULL OR manual_value >= 0),
  manual_updated_at TIMESTAMPTZ,
  manual_updated_by TEXT,
  notes             TEXT,
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO usage_budgets (provider, label, unit, source) VALUES
  ('alchemy',   'Alchemy (RPC)',          'llamadas', 'metered'),
  ('railway',   'Railway (servidor y BD)', 'USD',     'manual'),
  ('circle',    'Circle',                 'USD',      'manual'),
  ('monerium',  'Monerium',               'USD',      'manual'),
  ('openfort',  'Openfort',               'USD',      'manual'),
  ('dominio',   'Dominio',                'USD',      'manual'),
  ('dns',       'DNS',                    'USD',      'manual')
ON CONFLICT (provider) DO NOTHING;
`;
