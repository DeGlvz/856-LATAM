// 014 — Portal fase 4: obligaciones originadas por el cliente y aceptadas por su contraparte.
//   • Estados nuevos: pending_acceptance → open (aceptada) | rejected | expired. Solo las abiertas entran a compensación.
//   • Origen verificable, aceptación y rechazo con motivo, vencimiento de la aceptación.
//   • Carga masiva por CSV en dos pasos (validar → confirmar).
//   • Código de contraparte público y aleatorio por cliente (sin búsqueda ni lista: no permite enumerar clientes).
// Idempotente: puede re-ejecutarse sin error. Las obligaciones existentes conservan su estado.
export default /* sql */ `
-- ───── Código de contraparte: 856-XXXX-XXXX (30 símbolos sin 0/O/1/I/L/U: ≈39 bits) ─────
CREATE OR REPLACE FUNCTION gen_counterparty_code() RETURNS TEXT LANGUAGE plpgsql VOLATILE AS $$
DECLARE
  alphabet CONSTANT TEXT := '23456789ABCDEFGHJKMNPQRSTVWXYZ';
  b BYTEA := decode(replace(gen_random_uuid()::text, '-', ''), 'hex') || decode(replace(gen_random_uuid()::text, '-', ''), 'hex');
  out TEXT := '';
  i INT;
BEGIN
  -- bytes 0..5 y 10..15 de cada UUID v4 son aleatorios (se evitan los de versión y variante)
  FOREACH i IN ARRAY ARRAY[0,1,2,3,4,5,10,11] LOOP
    out := out || substr(alphabet, (get_byte(b, i) % 30) + 1, 1);
  END LOOP;
  RETURN '856-' || substr(out, 1, 4) || '-' || substr(out, 5, 4);
END $$;

ALTER TABLE clients ADD COLUMN IF NOT EXISTS counterparty_code TEXT;
UPDATE clients SET counterparty_code = gen_counterparty_code() WHERE counterparty_code IS NULL;
ALTER TABLE clients ALTER COLUMN counterparty_code SET DEFAULT gen_counterparty_code();
ALTER TABLE clients ALTER COLUMN counterparty_code SET NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS clients_counterparty_code_idx ON clients (counterparty_code);

-- ───── Carga masiva ─────
CREATE TABLE IF NOT EXISTS obligation_imports (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id   UUID NOT NULL REFERENCES clients(id),
  filename    TEXT,
  total_rows  INT NOT NULL,
  valid_rows  INT NOT NULL,
  rows        JSONB NOT NULL DEFAULT '[]',   -- filas válidas ya normalizadas (unidades base)
  errors      JSONB NOT NULL DEFAULT '[]',   -- [{row, field, message}]
  status      TEXT NOT NULL DEFAULT 'validated' CHECK (status IN ('validated','committed','discarded')),
  created_by  TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  decided_at  TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS obligation_imports_client_idx ON obligation_imports (client_id, created_at DESC);

-- ───── Obligaciones: aceptación por el deudor ─────
ALTER TABLE obligations DROP CONSTRAINT IF EXISTS obligations_status_check;
ALTER TABLE obligations ADD CONSTRAINT obligations_status_check
  CHECK (status IN ('pending_acceptance','open','settled','cancelled','rejected','expired'));
ALTER TABLE obligations
  ADD COLUMN IF NOT EXISTS origin_kind     TEXT CHECK (origin_kind IN ('client_user','client_key','delegate','console','api')),
  ADD COLUMN IF NOT EXISTS origin_ref      TEXT,
  ADD COLUMN IF NOT EXISTS origin_ip       TEXT,
  ADD COLUMN IF NOT EXISTS created_by      TEXT,
  ADD COLUMN IF NOT EXISTS accept_due_at   TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS accepted_by     TEXT,
  ADD COLUMN IF NOT EXISTS accepted_at     TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS rejected_by     TEXT,
  ADD COLUMN IF NOT EXISTS rejected_at     TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS rejected_reason TEXT,
  ADD COLUMN IF NOT EXISTS import_id       UUID REFERENCES obligation_imports(id);
ALTER TABLE obligations DROP CONSTRAINT IF EXISTS obligations_rejected_reason_check;
ALTER TABLE obligations ADD CONSTRAINT obligations_rejected_reason_check
  CHECK (status <> 'rejected' OR (rejected_reason IS NOT NULL AND length(rejected_reason) >= 5));
CREATE INDEX IF NOT EXISTS obligations_pending_idx ON obligations (debtor_id, accept_due_at) WHERE status = 'pending_acceptance';
`;
