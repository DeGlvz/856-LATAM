// 034 - Solicitudes de acceso desde la página pública (856latam.com). Datos de contacto mínimos;
// el estado lo cambia un ejecutivo o tesorero desde la consola. Idempotente.
export default /* sql */ `
CREATE TABLE IF NOT EXISTS access_requests (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  full_name   TEXT NOT NULL CHECK (length(full_name) BETWEEN 2 AND 120),
  company     TEXT NOT NULL CHECK (length(company) BETWEEN 2 AND 160),
  email       TEXT NOT NULL CHECK (length(email) BETWEEN 5 AND 200),
  country     TEXT NOT NULL CHECK (length(country) BETWEEN 2 AND 80),
  volume      TEXT NOT NULL CHECK (volume IN ('lt_100k','100k_1m','1m_10m','gt_10m')),
  message     TEXT CHECK (message IS NULL OR length(message) <= 2000),
  status      TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new','contacted','closed')),
  ip          TEXT,
  user_agent  TEXT,
  handled_by  TEXT,
  handled_at  TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS access_requests_status_idx ON access_requests (status, created_at DESC);
`;
