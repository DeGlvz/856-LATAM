// 022 — Enlaces de restablecimiento de contraseña del portal, generados por la tesorería (un solo uso, con vencimiento).
export default /* sql */ `
CREATE TABLE IF NOT EXISTS client_password_resets (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES client_users(id) ON DELETE CASCADE,
  token_hash  TEXT NOT NULL UNIQUE,
  created_by  TEXT NOT NULL,
  expires_at  TIMESTAMPTZ NOT NULL,
  used_at     TIMESTAMPTZ,
  revoked_at  TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS client_password_resets_user_idx ON client_password_resets (user_id);
`;
