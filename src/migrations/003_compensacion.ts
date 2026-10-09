// 003 — Obligaciones entre clientes y corridas de compensación (netting multilateral)
export default /* sql */ `
CREATE TABLE netting_runs (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  asset_id        TEXT NOT NULL REFERENCES assets(id),
  status          TEXT NOT NULL CHECK (status IN ('settled')),
  cutoff          TIMESTAMPTZ,
  obligations     INT NOT NULL,
  participants    INT NOT NULL,
  gross_amount    NUMERIC(78,0) NOT NULL,             -- suma de obligaciones cruzadas
  net_amount      NUMERIC(78,0) NOT NULL,             -- lo que realmente se movió
  entry_id        UUID REFERENCES journal_entries(id),-- NULL si el neto fue 0 para todos
  idempotency_key TEXT UNIQUE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE netting_positions (
  run_id       UUID NOT NULL REFERENCES netting_runs(id),
  client_id    UUID NOT NULL REFERENCES clients(id),
  receivable   NUMERIC(78,0) NOT NULL,
  payable      NUMERIC(78,0) NOT NULL,
  net          NUMERIC(78,0) NOT NULL,                -- + recibe, - paga
  PRIMARY KEY (run_id, client_id)
);

CREATE TABLE obligations (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  debtor_id       UUID NOT NULL REFERENCES clients(id),
  creditor_id     UUID NOT NULL REFERENCES clients(id),
  asset_id        TEXT NOT NULL REFERENCES assets(id),
  amount          NUMERIC(78,0) NOT NULL CHECK (amount > 0),
  due_at          TIMESTAMPTZ,
  external_ref    TEXT,                                -- OC, factura, CFDI
  status          TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','settled','cancelled')),
  netting_run_id  UUID REFERENCES netting_runs(id),
  metadata        JSONB NOT NULL DEFAULT '{}',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  settled_at      TIMESTAMPTZ,
  CHECK (debtor_id <> creditor_id),
  CHECK ((status = 'settled') = (netting_run_id IS NOT NULL))
);
CREATE INDEX obligations_open_idx ON obligations (asset_id, due_at) WHERE status = 'open';
CREATE INDEX obligations_debtor_idx ON obligations (debtor_id);
CREATE INDEX obligations_creditor_idx ON obligations (creditor_id);
`;
