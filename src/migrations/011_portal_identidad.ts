// 011 — Portal de clientes, fase 1: usuarios por cliente, sesiones, 2FA, invitaciones y llaves de API por cliente.
// Aislamiento: todo registro cuelga de client_id y el servidor filtra por el de la sesión/llave.
export default /* sql */ `
CREATE TABLE client_users (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id        UUID NOT NULL REFERENCES clients(id),
  email            TEXT NOT NULL,
  name             TEXT NOT NULL,
  role             TEXT NOT NULL CHECK (role IN ('viewer','operator','approver','admin')),
  password_hash    TEXT NOT NULL,                          -- argon2id
  active           BOOLEAN NOT NULL DEFAULT true,
  failed_attempts  INT NOT NULL DEFAULT 0,
  locked_until     TIMESTAMPTZ,
  totp_secret_enc  TEXT,
  totp_pending_enc TEXT,
  totp_enabled_at  TIMESTAMPTZ,
  totp_last_step   BIGINT,
  last_login_at    TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (email = lower(email)),
  CHECK ((totp_enabled_at IS NULL) = (totp_secret_enc IS NULL))
);
CREATE UNIQUE INDEX client_users_email_idx ON client_users (email);   -- una persona, un cliente
CREATE INDEX client_users_client_idx ON client_users (client_id);

CREATE TABLE client_sessions (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash   TEXT NOT NULL UNIQUE,
  user_id      UUID NOT NULL REFERENCES client_users(id),
  client_id    UUID NOT NULL REFERENCES clients(id),
  ip           TEXT,
  user_agent   TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at   TIMESTAMPTZ NOT NULL,
  revoked_at   TIMESTAMPTZ
);
CREATE INDEX client_sessions_user_idx ON client_sessions (user_id) WHERE revoked_at IS NULL;

CREATE TABLE client_mfa_challenges (
  token_hash TEXT PRIMARY KEY,
  user_id    UUID NOT NULL REFERENCES client_users(id),
  attempts   INT NOT NULL DEFAULT 0,
  expires_at TIMESTAMPTZ NOT NULL,
  used_at    TIMESTAMPTZ
);

-- Códigos de recuperación de un solo uso (alternativa al TOTP si se pierde el teléfono)
CREATE TABLE client_recovery_codes (
  user_id   UUID NOT NULL REFERENCES client_users(id),
  code_hash TEXT NOT NULL,
  used_at   TIMESTAMPTZ,
  PRIMARY KEY (user_id, code_hash)
);

CREATE TABLE client_invites (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id  UUID NOT NULL REFERENCES clients(id),
  email      TEXT NOT NULL CHECK (email = lower(email)),
  role       TEXT NOT NULL CHECK (role IN ('viewer','operator','approver','admin')),
  token_hash TEXT NOT NULL UNIQUE,
  created_by TEXT NOT NULL,                                -- 'portal:<correo>' u 'operador:<correo>' (primer admin)
  expires_at TIMESTAMPTZ NOT NULL,
  used_at    TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX client_invites_client_idx ON client_invites (client_id, created_at DESC);

-- Llaves de API por cliente. Fabricadas por el sistema:
--   ed25519: el par se genera en el navegador del cliente; aquí solo la pública (firma por petición).
--   read_token: 256 bits generados por el servidor; aquí solo su SHA-256; solo lectura.
CREATE TABLE client_api_keys (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id     UUID NOT NULL REFERENCES clients(id),
  name          TEXT NOT NULL,
  kind          TEXT NOT NULL CHECK (kind IN ('ed25519','read_token')),
  prefix        TEXT NOT NULL UNIQUE,
  public_key    TEXT,                                      -- ed25519 crudo, base64url (32 bytes)
  token_hash    TEXT UNIQUE,                               -- read_token
  permissions   TEXT[] NOT NULL,
  ip_allowlist  TEXT[] NOT NULL DEFAULT '{}',
  expires_at    TIMESTAMPTZ NOT NULL,
  rotated_from  UUID REFERENCES client_api_keys(id),
  created_by    UUID NOT NULL REFERENCES client_users(id),
  last_used_at  TIMESTAMPTZ,
  last_used_ip  TEXT,
  failed_sigs   INT NOT NULL DEFAULT 0,
  locked_until  TIMESTAMPTZ,
  revoked_at    TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK ((kind = 'ed25519') = (public_key IS NOT NULL)),
  CHECK ((kind = 'read_token') = (token_hash IS NOT NULL)),
  CHECK (kind = 'ed25519' OR permissions <@ ARRAY['read']),
  CHECK (permissions <@ ARRAY['read','trade','withdraw'] AND cardinality(permissions) > 0)
);
CREATE INDEX client_api_keys_client_idx ON client_api_keys (client_id, created_at DESC);

-- Prueba de posesión: reto de un solo uso que el navegador firma con la privada recién generada
CREATE TABLE client_key_challenges (
  challenge  TEXT PRIMARY KEY,
  user_id    UUID NOT NULL REFERENCES client_users(id),
  expires_at TIMESTAMPTZ NOT NULL,
  used_at    TIMESTAMPTZ
);

-- Anti-replay: un nonce por llave no se acepta dos veces (se limpian tras la ventana)
CREATE TABLE client_api_nonces (
  key_id     UUID NOT NULL REFERENCES client_api_keys(id),
  nonce      TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (key_id, nonce)
);
CREATE INDEX client_api_nonces_created_idx ON client_api_nonces (created_at);

-- Bitácora: las acciones del portal llevan el cliente (base de la bitácora propia del cliente, fase 5)
ALTER TABLE audit_log ADD COLUMN client_id UUID REFERENCES clients(id);
CREATE INDEX audit_log_client_idx ON audit_log (client_id, id DESC) WHERE client_id IS NOT NULL;
`;
