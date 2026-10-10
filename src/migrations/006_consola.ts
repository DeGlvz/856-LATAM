// 006 — Consola de operación: operadores (login), sesiones y bitácora de auditoría inmutable
export default /* sql */ `
CREATE TABLE operators (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email           TEXT NOT NULL,
  name            TEXT NOT NULL,
  password_hash   TEXT NOT NULL,                       -- argon2id (formato PHC)
  role            TEXT NOT NULL CHECK (role IN ('lectura','operador','tesorero')),
  active          BOOLEAN NOT NULL DEFAULT true,
  failed_attempts INT NOT NULL DEFAULT 0,
  locked_until    TIMESTAMPTZ,
  last_login_at   TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (email = lower(email))
);
CREATE UNIQUE INDEX operators_email_idx ON operators (email);

-- El navegador solo guarda un token aleatorio (cookie httpOnly); aquí se guarda su SHA-256
CREATE TABLE operator_sessions (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash   TEXT NOT NULL UNIQUE,
  operator_id  UUID NOT NULL REFERENCES operators(id),
  ip           TEXT,
  user_agent   TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at   TIMESTAMPTZ NOT NULL,
  revoked_at   TIMESTAMPTZ
);
CREATE INDEX operator_sessions_operator_idx ON operator_sessions (operator_id) WHERE revoked_at IS NULL;

-- Bitácora: quién hizo qué, cuándo y desde dónde. Solo inserción.
CREATE TABLE audit_log (
  id          BIGSERIAL PRIMARY KEY,
  at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  operator_id UUID REFERENCES operators(id),           -- NULL: intento sin operador identificado
  actor       TEXT NOT NULL,                           -- email del operador o 'anonimo'
  action      TEXT NOT NULL,                           -- login | login_failed | logout | 'POST /v1/…'
  target      TEXT,
  status      INT,
  ip          TEXT,
  metadata    JSONB NOT NULL DEFAULT '{}'
);
CREATE INDEX audit_log_at_idx ON audit_log (at DESC);
CREATE INDEX audit_log_operator_idx ON audit_log (operator_id, at DESC);
CREATE TRIGGER audit_log_immutable BEFORE UPDATE OR DELETE ON audit_log FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- Índices para las vistas de la consola
CREATE INDEX clients_created_idx ON clients (created_at DESC, id DESC);
CREATE INDEX journal_entries_created_idx ON journal_entries (created_at DESC, id DESC);
`;
