// 018 — tokens de asistencia de soporte, aislados de las sesiones de clientes y solo lectura.
export default /* sql */ `
CREATE TABLE client_assist_tokens (
  token_hash     TEXT PRIMARY KEY,
  session_hash   TEXT UNIQUE,
  client_id      UUID NOT NULL REFERENCES clients(id),
  operator_id    UUID NOT NULL REFERENCES operators(id),
  operator_email TEXT NOT NULL,
  operator_name  TEXT NOT NULL,
  scope          TEXT NOT NULL DEFAULT 'read_only' CHECK (scope = 'read_only'),
  status         TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','revoked')),
  ip             TEXT,
  user_agent     TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  activated_at   TIMESTAMPTZ,
  expires_at     TIMESTAMPTZ NOT NULL,
  revoked_at     TIMESTAMPTZ,
  CHECK (expires_at <= created_at + interval '10 minutes')
);
CREATE INDEX client_assist_tokens_expiry_idx ON client_assist_tokens (expires_at) WHERE status = 'active';
`;
