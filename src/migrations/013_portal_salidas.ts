// 013 — Portal fase 3: salidas originadas por el cliente y autorizadas por tesorería de 856.
//   • Lista blanca del cliente con aprobación de un segundo usuario y periodo de espera.
//   • Simulación de salida con hash del alcance (lo que se autoriza es exactamente lo simulado).
//   • Retiros con origen verificable, aprobación interna del cliente y autorización (uno o dos tesoreros) atada al hash.
//   • Rol "operador" de la consola → "ejecutivo" (Ejecutivo de cuenta), con los mismos permisos.
// Idempotente: puede re-ejecutarse sin error.
export default /* sql */ `
-- ───── Rol de consola: operador → ejecutivo ─────
ALTER TABLE operators DROP CONSTRAINT IF EXISTS operators_role_check;
UPDATE operators SET role = 'ejecutivo' WHERE role = 'operador';
ALTER TABLE operators ADD CONSTRAINT operators_role_check CHECK (role IN ('lectura','ejecutivo','tesorero'));
ALTER TABLE operator_invites DROP CONSTRAINT IF EXISTS operator_invites_role_check;
UPDATE operator_invites SET role = 'ejecutivo' WHERE role = 'operador';
ALTER TABLE operator_invites ADD CONSTRAINT operator_invites_role_check CHECK (role IN ('lectura','ejecutivo','tesorero'));

-- ───── Lista blanca del cliente ─────
-- wl_status: pending_approval (la pidió un usuario) → active (la aprobó otro; usable desde active_from) → removed
ALTER TABLE wallets
  ADD COLUMN IF NOT EXISTS wl_status         TEXT,
  ADD COLUMN IF NOT EXISTS wl_requested_by   UUID REFERENCES client_users(id),
  ADD COLUMN IF NOT EXISTS wl_approved_by    UUID REFERENCES client_users(id),
  ADD COLUMN IF NOT EXISTS wl_requested_at   TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS wl_approved_at    TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS active_from       TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS removed_at        TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS removed_by        TEXT;
-- Las direcciones dadas de alta antes (desde la consola) quedan vigentes
UPDATE wallets SET wl_status = CASE WHEN active THEN 'active' ELSE 'removed' END
 WHERE purpose = 'withdrawal_whitelist' AND wl_status IS NULL;
ALTER TABLE wallets DROP CONSTRAINT IF EXISTS wallets_wl_status_check;
ALTER TABLE wallets ADD CONSTRAINT wallets_wl_status_check CHECK (
  (purpose <> 'withdrawal_whitelist' AND wl_status IS NULL)
  OR (purpose = 'withdrawal_whitelist' AND wl_status IN ('pending_approval','active','removed')));
ALTER TABLE wallets DROP CONSTRAINT IF EXISTS wallets_wl_four_eyes_check;
ALTER TABLE wallets ADD CONSTRAINT wallets_wl_four_eyes_check CHECK (
  wl_approved_by IS NULL OR wl_requested_by IS NULL OR wl_approved_by <> wl_requested_by);

-- ───── Umbrales ─────
-- Por activo: a partir de este monto (unidades base) la autorización de 856 requiere DOS tesoreros distintos
ALTER TABLE assets ADD COLUMN IF NOT EXISTS dual_treasurer_threshold NUMERIC(78,0) CHECK (dual_treasurer_threshold > 0);
-- Por cliente y activo: a partir de este monto el cliente requiere un aprobador distinto de quien origina
CREATE TABLE IF NOT EXISTS client_approval_thresholds (
  client_id  UUID NOT NULL REFERENCES clients(id),
  asset_id   TEXT NOT NULL REFERENCES assets(id),
  threshold  NUMERIC(78,0) NOT NULL CHECK (threshold > 0),
  updated_by UUID REFERENCES client_users(id),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (client_id, asset_id)
);

-- ───── Simulaciones de salida ─────
CREATE TABLE IF NOT EXISTS exit_simulations (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id      UUID NOT NULL REFERENCES clients(id),
  origin_kind    TEXT NOT NULL CHECK (origin_kind IN ('client_user','client_key','delegate')),
  origin_ref     TEXT NOT NULL,                       -- id del usuario, prefijo de la llave o id del gestor
  asset_id       TEXT NOT NULL REFERENCES assets(id),
  wallet_id      UUID NOT NULL REFERENCES wallets(id),
  to_address     TEXT NOT NULL,
  amount         NUMERIC(78,0) NOT NULL CHECK (amount > 0),
  fee            NUMERIC(78,0) NOT NULL DEFAULT 0,    -- comisión de 856 (hoy 0)
  gas_estimate   NUMERIC(78,0),                       -- en unidades base del activo nativo; lo paga 856
  available      NUMERIC(78,0) NOT NULL,              -- saldo disponible al simular
  balance_after  NUMERIC(78,0) NOT NULL,
  payable_open   NUMERIC(78,0) NOT NULL DEFAULT 0,    -- obligaciones abiertas por pagar en el activo
  obligations    JSONB NOT NULL DEFAULT '[]',
  scope_hash     TEXT NOT NULL,
  status         TEXT NOT NULL DEFAULT 'simulated' CHECK (status IN ('simulated','submitted','expired')),
  expires_at     TIMESTAMPTZ NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS exit_simulations_client_idx ON exit_simulations (client_id, created_at DESC);

-- ───── Retiros: origen, aprobación del cliente y autorización de 856 ─────
ALTER TABLE withdrawals DROP CONSTRAINT IF EXISTS withdrawals_approval_status_check;
ALTER TABLE withdrawals ADD CONSTRAINT withdrawals_approval_status_check
  CHECK (approval_status IN ('not_required','client_pending','pending','approved','rejected'));
ALTER TABLE withdrawals DROP CONSTRAINT IF EXISTS withdrawals_check;
ALTER TABLE withdrawals ADD CONSTRAINT withdrawals_check
  CHECK (approval_status NOT IN ('pending','client_pending') OR status IN ('reserved','cancelled'));
ALTER TABLE withdrawals
  ADD COLUMN IF NOT EXISTS origin_kind           TEXT CHECK (origin_kind IN ('client_user','client_key','delegate','console','api')),
  ADD COLUMN IF NOT EXISTS origin_ref            TEXT,
  ADD COLUMN IF NOT EXISTS origin_ip             TEXT,
  ADD COLUMN IF NOT EXISTS simulation_id         UUID REFERENCES exit_simulations(id),
  ADD COLUMN IF NOT EXISTS scope_hash            TEXT,
  ADD COLUMN IF NOT EXISTS client_approved_by    UUID REFERENCES client_users(id),
  ADD COLUMN IF NOT EXISTS client_approved_at    TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS validation_due_at     TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS dual_required         BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS approved2_by           TEXT,
  ADD COLUMN IF NOT EXISTS approved2_by_operator UUID REFERENCES operators(id),
  ADD COLUMN IF NOT EXISTS approved2_at          TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS authorized_hash       TEXT;
ALTER TABLE withdrawals DROP CONSTRAINT IF EXISTS withdrawals_two_treasurers_check;
ALTER TABLE withdrawals ADD CONSTRAINT withdrawals_two_treasurers_check
  CHECK (approved2_by_operator IS NULL OR approved_by_operator IS NULL OR approved2_by_operator <> approved_by_operator);
CREATE UNIQUE INDEX IF NOT EXISTS withdrawals_simulation_idx ON withdrawals (simulation_id) WHERE simulation_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS withdrawals_client_pending_idx ON withdrawals (client_id, created_at) WHERE approval_status = 'client_pending';
`;
