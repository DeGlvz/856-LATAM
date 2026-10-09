// 005 — Direcciones de depósito derivadas (HD), registro en webhook y barrido a la hot wallet
export default /* sql */ `
CREATE SEQUENCE deposit_address_index START 0 MINVALUE 0;

ALTER TABLE wallets
  ADD COLUMN derivation_index   INT,
  ADD COLUMN webhook_registered BOOLEAN NOT NULL DEFAULT false;
CREATE UNIQUE INDEX wallets_derivation_idx ON wallets (network, derivation_index) WHERE derivation_index IS NOT NULL;

-- Movimientos internos entre wallets de la plataforma: no cambian la custodia, solo cuesta gas
CREATE TABLE sweeps (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  wallet_id     UUID NOT NULL REFERENCES wallets(id),        -- dirección de depósito involucrada
  kind          TEXT NOT NULL CHECK (kind IN ('gas_topup','sweep_token','sweep_native')),
  asset_id      TEXT NOT NULL REFERENCES assets(id),
  amount        NUMERIC(78,0) NOT NULL CHECK (amount > 0),
  from_address  TEXT NOT NULL,
  to_address    TEXT NOT NULL,
  nonce         BIGINT NOT NULL,
  raw_tx        TEXT NOT NULL,
  tx_hash       TEXT NOT NULL UNIQUE,
  status        TEXT NOT NULL CHECK (status IN ('signed','broadcast','confirmed','failed')),
  block_number  BIGINT,
  gas_cost_wei  NUMERIC(78,0),
  gas_entry_id  UUID REFERENCES journal_entries(id),
  last_error    TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX sweeps_open_idx ON sweeps (status) WHERE status IN ('signed','broadcast');
CREATE UNIQUE INDEX sweeps_nonce_idx ON sweeps (from_address, nonce) WHERE status <> 'failed';
`;
