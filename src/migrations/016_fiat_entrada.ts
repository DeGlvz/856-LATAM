// 016 — Fase F1: entrada de fiat (SEPA → EURe) con proveedor regulado (Monerium), modo tesorería única.
//   • fiat_accounts: la cuenta del proveedor (perfil, IBAN, beneficiario) ligada a una dirección HD reservada de 856.
//   • fiat_payment_intents: avisos de pago que crea el cliente (referencia única que pone en su transferencia SEPA).
//   • fiat_deposits: cada orden de entrada del proveedor, su acuñación on-chain y su conciliación/liberación.
//   • wallets.purpose 'fiat_treasury': la dirección de tesorería fiat (sin cliente; se barre a la hot wallet).
// Montos sin float: EUR en céntimos (2 decimales) y su equivalente EURe en unidades base (18 decimales) = céntimos × 10^16.
// Idempotente: puede re-ejecutarse sin error.
export default /* sql */ `
-- ───── Dirección de tesorería fiat ─────
ALTER TABLE wallets DROP CONSTRAINT IF EXISTS wallets_purpose_check;
ALTER TABLE wallets ADD CONSTRAINT wallets_purpose_check
  CHECK (purpose IN ('master_hot','master_cold','deposit','withdrawal_whitelist','fiat_treasury'));
ALTER TABLE wallets DROP CONSTRAINT IF EXISTS wallets_fiat_treasury_no_client;
ALTER TABLE wallets ADD CONSTRAINT wallets_fiat_treasury_no_client CHECK (purpose <> 'fiat_treasury' OR client_id IS NULL);

-- ───── Cuenta con el proveedor ─────
CREATE TABLE IF NOT EXISTS fiat_accounts (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider         TEXT NOT NULL CHECK (provider IN ('monerium','mock')),
  mode             TEXT NOT NULL DEFAULT 'treasury' CHECK (mode IN ('treasury','per_client')),
  client_id        UUID REFERENCES clients(id),                 -- solo modo per_client (no implementado)
  profile_id       TEXT,
  iban             TEXT,
  bic              TEXT,
  beneficiary      TEXT,
  network          TEXT NOT NULL,
  address          TEXT NOT NULL,
  derivation_index INT NOT NULL,
  wallet_id        UUID REFERENCES wallets(id),
  status           TEXT NOT NULL DEFAULT 'pending_link'
                   CHECK (status IN ('pending_link','linked','iban_requested','active','closed')),
  provider_state   TEXT,                                        -- último estado del IBAN según el proveedor
  created_by       TEXT NOT NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (mode = 'per_client' OR client_id IS NULL)
);
-- Modo tesorería: una sola cuenta vigente por proveedor
CREATE UNIQUE INDEX IF NOT EXISTS fiat_accounts_treasury_idx ON fiat_accounts (provider) WHERE mode = 'treasury' AND status <> 'closed';
CREATE UNIQUE INDEX IF NOT EXISTS fiat_accounts_iban_idx ON fiat_accounts (iban) WHERE iban IS NOT NULL;

-- ───── Avisos de pago (los crea solo el cliente) ─────
CREATE TABLE IF NOT EXISTS fiat_payment_intents (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id        UUID NOT NULL REFERENCES clients(id),
  reference        TEXT NOT NULL UNIQUE CHECK (reference ~ '^856-[A-Z0-9]{4}-[A-Z0-9]{4}-[0-9]{3}$'),
  expected_amount  NUMERIC(78,0) NOT NULL CHECK (expected_amount > 0),   -- céntimos de EUR
  currency         TEXT NOT NULL DEFAULT 'EUR' CHECK (currency = 'EUR'),
  expected_date    DATE,
  note             TEXT CHECK (length(note) <= 300),
  expires_at       TIMESTAMPTZ NOT NULL,
  status           TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','matched','expired','cancelled')),
  origin_kind      TEXT NOT NULL CHECK (origin_kind IN ('client_user','client_key','delegate')),
  origin_ref       TEXT NOT NULL,                               -- id del usuario o prefijo de la llave
  origin_ip        TEXT,
  origin_signature TEXT,                                        -- firma Ed25519 de la petición (llave)
  created_by       TEXT NOT NULL,
  matched_deposit_id UUID,
  cancelled_by     TEXT,
  cancelled_at     TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS fiat_intents_client_idx ON fiat_payment_intents (client_id, created_at DESC);
CREATE INDEX IF NOT EXISTS fiat_intents_open_idx ON fiat_payment_intents (expires_at) WHERE status = 'open';

-- ───── Depósitos fiat ─────
CREATE TABLE IF NOT EXISTS fiat_deposits (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  fiat_account_id    UUID NOT NULL REFERENCES fiat_accounts(id),
  provider           TEXT NOT NULL,
  provider_order_id  TEXT NOT NULL,
  amount_cents       NUMERIC(78,0) NOT NULL CHECK (amount_cents > 0),     -- EUR, 2 decimales
  token_amount       NUMERIC(78,0) NOT NULL CHECK (token_amount > 0),     -- EURe, 18 decimales (= céntimos × 10^16)
  asset_id           TEXT NOT NULL REFERENCES assets(id),
  currency           TEXT NOT NULL DEFAULT 'EUR',
  reference          TEXT,                                     -- concepto SEPA tal como llegó
  payer_iban_masked  TEXT,
  payer_name         TEXT,
  network            TEXT NOT NULL,
  tx_hash            TEXT,
  log_index          INT,
  block_number       BIGINT,
  confirmations      INT NOT NULL DEFAULT 0,
  client_id          UUID REFERENCES clients(id),
  intent_id          UUID REFERENCES fiat_payment_intents(id),
  match_rule         TEXT CHECK (match_rule IN ('intent','counterparty','manual')),
  review_reason      TEXT,
  entry_id           UUID REFERENCES journal_entries(id),
  status             TEXT NOT NULL DEFAULT 'received'
                     CHECK (status IN ('received','minted','reconciled','released','review','rejected')),
  released_by        TEXT,
  released_at        TIMESTAMPTZ,
  reason             TEXT,
  provider_state     TEXT,
  provider_payload   JSONB NOT NULL DEFAULT '{}',
  received_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  minted_at          TIMESTAMPTZ,
  reconciled_at      TIMESTAMPTZ,
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (provider, provider_order_id),
  CHECK (token_amount = amount_cents * 10000000000000000),
  CHECK (status NOT IN ('released') OR (client_id IS NOT NULL AND entry_id IS NOT NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS fiat_deposits_tx_idx ON fiat_deposits (network, tx_hash) WHERE tx_hash IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS fiat_deposits_entry_idx ON fiat_deposits (entry_id) WHERE entry_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS fiat_deposits_client_idx ON fiat_deposits (client_id, received_at DESC);
CREATE INDEX IF NOT EXISTS fiat_deposits_open_idx ON fiat_deposits (received_at) WHERE status IN ('received','minted','reconciled','review');

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fiat_intents_matched_fk') THEN
    ALTER TABLE fiat_payment_intents ADD CONSTRAINT fiat_intents_matched_fk FOREIGN KEY (matched_deposit_id) REFERENCES fiat_deposits(id);
  END IF;
END $$;

-- Cursor del sondeo de órdenes del proveedor
CREATE TABLE IF NOT EXISTS fiat_sync_state (
  provider     TEXT PRIMARY KEY,
  last_poll_at TIMESTAMPTZ,
  last_error   TEXT,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
`;
