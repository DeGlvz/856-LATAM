// 024 — Rieles fiat múltiples: interruptores por riel y cuentas bancarias versionadas y cifradas (AES-256-GCM, FIAT_RAILS_ENC_KEY).
// Los rieles se siembran APAGADOS y sin cuenta; los datos bancarios los cargan tesoreros desde la consola (doble aprobación).
export default /* sql */ `
CREATE TABLE IF NOT EXISTS fiat_rails (
  rail_id             TEXT PRIMARY KEY CHECK (rail_id ~ '^[a-z0-9][a-z0-9_-]{1,39}$'),
  label               TEXT NOT NULL,
  currency            TEXT NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  country             TEXT,
  rail_type           TEXT NOT NULL CHECK (rail_type IN ('wire','ach','sepa','spei','pix','otc','generic')),
  kind                TEXT NOT NULL CHECK (kind IN ('manual','automatic')),
  priority            INT NOT NULL DEFAULT 100,
  fallback_of         TEXT REFERENCES fiat_rails(rail_id),
  is_enabled          BOOLEAN NOT NULL DEFAULT false,
  visibility          TEXT NOT NULL DEFAULT 'all' CHECK (visibility IN ('all','restricted')),
  maintenance_message TEXT,
  min_amount          NUMERIC(20,2) CHECK (min_amount IS NULL OR min_amount >= 0),
  max_amount          NUMERIC(20,2) CHECK (max_amount IS NULL OR max_amount >= 0),
  recommended_for     TEXT,
  settlement_time     TEXT,
  requires_review     BOOLEAN NOT NULL DEFAULT true,
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by          TEXT
);

-- Rieles restringidos: solo los clientes asignados los ven y pueden usarlos.
CREATE TABLE IF NOT EXISTS fiat_rail_clients (
  rail_id     TEXT NOT NULL REFERENCES fiat_rails(rail_id),
  client_id   UUID NOT NULL REFERENCES clients(id),
  assigned_by TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (rail_id, client_id)
);
CREATE INDEX IF NOT EXISTS fiat_rail_clients_client_idx ON fiat_rail_clients (client_id);

CREATE TABLE IF NOT EXISTS fiat_rail_accounts (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  rail_id        TEXT NOT NULL REFERENCES fiat_rails(rail_id),
  version        INT NOT NULL,
  details_enc    TEXT NOT NULL,
  last4          TEXT NOT NULL,
  changed_fields TEXT[] NOT NULL DEFAULT '{}',
  status         TEXT NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed','active','superseded','rejected')),
  is_active      BOOLEAN NOT NULL DEFAULT false,
  proposal_reason TEXT NOT NULL,
  decision_reason TEXT,
  created_by     TEXT NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  approved_by    TEXT,
  approved_at    TIMESTAMPTZ,
  UNIQUE (rail_id, version)
);
CREATE UNIQUE INDEX IF NOT EXISTS fiat_rail_accounts_one_active ON fiat_rail_accounts (rail_id) WHERE is_active;

-- Historial inmutable: nunca se borra ni se reescribe el contenido; solo cambia el estado de la versión.
CREATE OR REPLACE FUNCTION fiat_rail_accounts_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'fiat_rail_accounts es inmutable'; END IF;
  IF NEW.rail_id <> OLD.rail_id OR NEW.version <> OLD.version OR NEW.details_enc <> OLD.details_enc
     OR NEW.last4 <> OLD.last4 OR NEW.created_by <> OLD.created_by OR NEW.created_at <> OLD.created_at
     OR NEW.proposal_reason <> OLD.proposal_reason OR NEW.changed_fields <> OLD.changed_fields THEN
    RAISE EXCEPTION 'fiat_rail_accounts es inmutable: cree una versión nueva';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS fiat_rail_accounts_immutable ON fiat_rail_accounts;
CREATE TRIGGER fiat_rail_accounts_immutable BEFORE UPDATE OR DELETE ON fiat_rail_accounts
  FOR EACH ROW EXECUTE FUNCTION fiat_rail_accounts_immutable();

-- Semillas: solo interruptores APAGADOS y sin cuenta bancaria.
INSERT INTO fiat_rails (rail_id, label, currency, country, rail_type, kind, priority, fallback_of, recommended_for, settlement_time, requires_review) VALUES
  ('monerium-eur',   'Monerium EUR (SEPA automático)', 'EUR', NULL, 'sepa',    'automatic', 10, NULL,           NULL,                              '1-2 días hábiles', false),
  ('wire-usd',       'Wire/ACH USD',                   'USD', 'US', 'wire',    'manual',    10, NULL,           'Recomendado para montos grandes', '1-2 días hábiles', true),
  ('revolut-eur',    'Revolut Business EUR (SEPA)',    'EUR', NULL, 'sepa',    'manual',    20, 'monerium-eur', NULL,                              '1-2 días hábiles', true),
  ('revolut-gbp',    'Revolut Business GBP',           'GBP', 'GB', 'generic', 'manual',    20, NULL,           NULL,                              '1-2 días hábiles', true),
  ('revolut-usd',    'Revolut Business USD',           'USD', 'US', 'wire',    'manual',    30, 'wire-usd',     NULL,                              '1-3 días hábiles', true),
  ('contingencia-usd','Contingencia USD',              'USD', NULL, 'generic', 'manual',    90, 'wire-usd',     NULL,                              'Según acuerdo',    true),
  ('otc-limitless',  'OTC Limitless',                  'USD', NULL, 'otc',     'automatic', 50, NULL,           NULL,                              'Según acuerdo',    true)
ON CONFLICT (rail_id) DO NOTHING;
`;
