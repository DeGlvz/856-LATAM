// 004 — Transferencias on-chain: retiros (firma, envío, confirmaciones) y depósitos detectados
export default /* sql */ `
CREATE TABLE withdrawals (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id          UUID NOT NULL REFERENCES clients(id),
  account_id         UUID NOT NULL REFERENCES accounts(id),
  asset_id           TEXT NOT NULL REFERENCES assets(id),
  to_address         TEXT NOT NULL,
  amount             NUMERIC(78,0) NOT NULL CHECK (amount > 0),
  status             TEXT NOT NULL CHECK (status IN
                       ('reserved','signed','broadcast','confirmed','failed','cancelled')),
  from_address       TEXT,
  nonce              BIGINT,
  raw_tx             TEXT,                 -- firmada ANTES de enviar: permite reenviar tras una caída
  tx_hash            TEXT UNIQUE,
  block_number       BIGINT,
  confirmations      INT NOT NULL DEFAULT 0,
  gas_used           NUMERIC(78,0),
  gas_cost_wei       NUMERIC(78,0),
  attempts           INT NOT NULL DEFAULT 0,
  last_error         TEXT,
  reserve_entry_id   UUID REFERENCES journal_entries(id),
  settle_entry_id    UUID REFERENCES journal_entries(id),
  reversal_entry_id  UUID REFERENCES journal_entries(id),
  idempotency_key    TEXT UNIQUE,
  metadata           JSONB NOT NULL DEFAULT '{}',
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX withdrawals_pending_idx ON withdrawals (status, created_at) WHERE status IN ('reserved','signed','broadcast');
CREATE INDEX withdrawals_client_idx ON withdrawals (client_id, created_at DESC);
CREATE UNIQUE INDEX withdrawals_nonce_idx ON withdrawals (from_address, nonce) WHERE nonce IS NOT NULL AND status <> 'failed';

CREATE TABLE deposits (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tx_hash        TEXT NOT NULL,
  log_index      INT NOT NULL,            -- -1 para transferencias nativas
  wallet_id      UUID NOT NULL REFERENCES wallets(id),
  client_id      UUID NOT NULL REFERENCES clients(id),
  asset_id       TEXT NOT NULL REFERENCES assets(id),
  from_address   TEXT,
  amount         NUMERIC(78,0) NOT NULL CHECK (amount > 0),
  block_number   BIGINT NOT NULL,
  confirmations  INT NOT NULL DEFAULT 0,
  status         TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','credited','orphaned')),
  entry_id       UUID REFERENCES journal_entries(id),
  source         TEXT NOT NULL DEFAULT 'api',   -- api | webhook
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  credited_at    TIMESTAMPTZ,
  UNIQUE (tx_hash, log_index)
);
CREATE INDEX deposits_pending_idx ON deposits (status) WHERE status = 'pending';
`;
