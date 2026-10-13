// 009 — Fase 5: segundo factor (TOTP) para operadores y doble aprobación de retiros y corridas de compensación
export default /* sql */ `
-- 2FA: el secreto se guarda cifrado (AES-256-GCM, llave fuera de la base). last_step impide reutilizar un código.
ALTER TABLE operators
  ADD COLUMN totp_secret_enc  TEXT,
  ADD COLUMN totp_pending_enc TEXT,           -- secreto generado y aún no confirmado
  ADD COLUMN totp_enabled_at  TIMESTAMPTZ,
  ADD COLUMN totp_last_step   BIGINT,
  ADD CHECK ((totp_enabled_at IS NULL) = (totp_secret_enc IS NULL));

-- Login en dos pasos: contraseña correcta → reto de corta vida que se canjea con el código TOTP
CREATE TABLE operator_mfa_challenges (
  token_hash  TEXT PRIMARY KEY,
  operator_id UUID NOT NULL REFERENCES operators(id),
  ip          TEXT,
  user_agent  TEXT,
  attempts    INT NOT NULL DEFAULT 0,
  expires_at  TIMESTAMPTZ NOT NULL,
  used_at     TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Retiros: el saldo se reserva al pedirlo; el worker no firma hasta que otro tesorero apruebe
ALTER TABLE withdrawals
  ADD COLUMN approval_status       TEXT NOT NULL DEFAULT 'not_required'
    CHECK (approval_status IN ('not_required','pending','approved','rejected')),
  ADD COLUMN requested_by          TEXT,
  ADD COLUMN requested_by_operator UUID REFERENCES operators(id),
  ADD COLUMN approved_by           TEXT,
  ADD COLUMN approved_by_operator  UUID REFERENCES operators(id),
  ADD COLUMN approved_at           TIMESTAMPTZ,
  ADD COLUMN rejected_by           TEXT,
  ADD COLUMN rejected_reason       TEXT,
  ADD CHECK (approval_status <> 'pending' OR status IN ('reserved','cancelled')),
  ADD CHECK (approved_by_operator IS NULL OR requested_by_operator IS NULL OR approved_by_operator <> requested_by_operator);
CREATE INDEX withdrawals_pending_approval_idx ON withdrawals (created_at) WHERE approval_status = 'pending';

-- Corridas: se solicitan (pending_approval) con el alcance simulado y se liquidan al aprobarse
ALTER TABLE netting_runs DROP CONSTRAINT netting_runs_status_check;
ALTER TABLE netting_runs
  ADD CONSTRAINT netting_runs_status_check CHECK (status IN ('pending_approval','settled','rejected')),
  ADD COLUMN scope                 JSONB,
  ADD COLUMN expected_net_amount   NUMERIC(78,0),
  ADD COLUMN requested_by_operator UUID REFERENCES operators(id),
  ADD COLUMN approved_by           TEXT,
  ADD COLUMN approved_by_operator  UUID REFERENCES operators(id),
  ADD COLUMN decided_at            TIMESTAMPTZ,
  ADD COLUMN rejected_by           TEXT,
  ADD COLUMN rejected_reason       TEXT,
  ADD COLUMN last_error            TEXT,
  ADD CHECK (approved_by_operator IS NULL OR requested_by_operator IS NULL OR approved_by_operator <> requested_by_operator);
CREATE INDEX netting_runs_pending_idx ON netting_runs (created_at) WHERE status = 'pending_approval';

-- Bitácora: búsqueda por acción y actor
CREATE INDEX audit_log_action_idx ON audit_log (action, id DESC);
CREATE INDEX audit_log_actor_idx  ON audit_log (actor, id DESC);
`;
