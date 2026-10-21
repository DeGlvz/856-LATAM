// 031 - Configuracion de cliente preparada por el ejecutivo y liberada por el tesorero.
// El ejecutivo arma borradores (alta de direccion en lista blanca, umbral de aprobacion), los envia a tesoreria
// y solo al liberarlos un tesorero (con 2FA) se aplican al cliente. Idempotente.
export default /* sql */ `
CREATE TABLE IF NOT EXISTS client_config_drafts (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id      UUID NOT NULL REFERENCES clients(id),
  kind           TEXT NOT NULL CHECK (kind IN ('whitelist','threshold')),
  payload        JSONB NOT NULL,
  status         TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','submitted','released','rejected','cancelled')),
  created_by     UUID REFERENCES operators(id),
  created_by_email TEXT NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  submitted_at   TIMESTAMPTZ,
  decided_by     UUID REFERENCES operators(id),
  decided_by_email TEXT,
  decided_at     TIMESTAMPTZ,
  decision_note  TEXT,
  applied_ref    TEXT
);
CREATE INDEX IF NOT EXISTS client_config_drafts_client_idx ON client_config_drafts (client_id, created_at DESC);
CREATE INDEX IF NOT EXISTS client_config_drafts_submitted_idx ON client_config_drafts (submitted_at) WHERE status = 'submitted';
`;
