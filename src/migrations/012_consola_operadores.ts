// 012 — Consola: alta de operadores por invitación (enlace de un solo uso) y baja lógica con rastro de quién la hizo.
// Idempotente: puede re-ejecutarse sin error.
export default /* sql */ `
CREATE TABLE IF NOT EXISTS operator_invites (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email      TEXT NOT NULL CHECK (email = lower(email)),
  role       TEXT NOT NULL CHECK (role IN ('lectura','operador','tesorero')),
  token_hash TEXT NOT NULL UNIQUE,                         -- SHA-256 del token; el token solo viaja en el fragmento (#)
  created_by UUID NOT NULL REFERENCES operators(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  used_at    TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  CHECK (used_at IS NULL OR revoked_at IS NULL)
);
CREATE INDEX IF NOT EXISTS operator_invites_open_idx ON operator_invites (email) WHERE used_at IS NULL AND revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS operator_invites_created_idx ON operator_invites (created_at DESC);

ALTER TABLE operators
  ADD COLUMN IF NOT EXISTS deactivated_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS deactivated_by UUID REFERENCES operators(id);
`;
