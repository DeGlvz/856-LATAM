// 001 — Núcleo contable: activos, clientes, wallets, cuentas, asientos (doble partida) e idempotencia.
// Montos SIEMPRE en unidades base (wei, sun, satoshi) como NUMERIC(78,0): sin decimales ni flotantes.
export default /* sql */ `
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- Catálogo de activos soportados (Bitcoin, ERC-20, TRC-20, Litecoin, nativos EVM)
CREATE TABLE assets (
  id               TEXT PRIMARY KEY,                 -- p.ej. 'USDC-ETH-SEPOLIA'
  symbol           TEXT NOT NULL,
  chain            TEXT NOT NULL,                    -- ethereum | tron | bitcoin | litecoin
  network          TEXT NOT NULL,                    -- eth-sepolia, tron-nile, btc-testnet…
  kind             TEXT NOT NULL CHECK (kind IN ('native','erc20','trc20','utxo')),
  contract_address TEXT,
  decimals         SMALLINT NOT NULL CHECK (decimals BETWEEN 0 AND 36),
  active           BOOLEAN NOT NULL DEFAULT true,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK ((kind IN ('erc20','trc20')) = (contract_address IS NOT NULL)),
  UNIQUE (network, contract_address)
);

-- Clientes (fondos, tesorerías, fintechs de marca blanca)
CREATE TABLE clients (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  external_id TEXT UNIQUE,                            -- id del cliente en su ERP / sistema
  name        TEXT NOT NULL,
  kind        TEXT NOT NULL DEFAULT 'corporate' CHECK (kind IN ('corporate','fund','fintech','individual')),
  status      TEXT NOT NULL DEFAULT 'pending_kyb' CHECK (status IN ('pending_kyb','active','suspended','closed')),
  metadata    JSONB NOT NULL DEFAULT '{}',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Direcciones on-chain registradas. NUNCA se guardan llaves privadas (custodia vía MPC externo).
CREATE TABLE wallets (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id       UUID REFERENCES clients(id),        -- NULL = wallet de la plataforma (master)
  chain           TEXT NOT NULL,
  network         TEXT NOT NULL,
  address         TEXT NOT NULL,
  purpose         TEXT NOT NULL CHECK (purpose IN ('master_hot','master_cold','deposit','withdrawal_whitelist')),
  custody_ref     TEXT,                               -- referencia en el proveedor MPC
  derivation_path TEXT,
  label           TEXT,
  active          BOOLEAN NOT NULL DEFAULT true,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (network, address),
  CHECK (purpose NOT IN ('master_hot','master_cold') OR client_id IS NULL)
);

-- Cuentas contables. Saldo expresado en su lado normal (débito o crédito).
CREATE TABLE accounts (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code           TEXT NOT NULL UNIQUE,                -- 'client:<uuid>:USDC-ETH-SEPOLIA:available'
  client_id      UUID REFERENCES clients(id),
  asset_id       TEXT NOT NULL REFERENCES assets(id),
  type           TEXT NOT NULL CHECK (type IN ('asset','liability','equity','revenue','expense')),
  normal_side    TEXT NOT NULL CHECK (normal_side IN ('debit','credit')),
  allow_negative BOOLEAN NOT NULL DEFAULT false,
  balance        NUMERIC(78,0) NOT NULL DEFAULT 0,
  version        BIGINT NOT NULL DEFAULT 0,
  name           TEXT NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (allow_negative OR balance >= 0),
  CHECK (normal_side = CASE WHEN type IN ('asset','expense') THEN 'debit' ELSE 'credit' END)
);
CREATE INDEX accounts_client_idx ON accounts (client_id);

-- Asientos contables (cabecera)
CREATE TABLE journal_entries (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  kind            TEXT NOT NULL,                      -- deposit | withdrawal | transfer | fee | conversion | netting | adjustment
  description     TEXT,
  external_ref    TEXT,                               -- tx hash, folio OC/factura, CFDI…
  idempotency_key TEXT UNIQUE,
  metadata        JSONB NOT NULL DEFAULT '{}',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Partidas: cada una es un débito o crédito positivo sobre una cuenta
CREATE TABLE postings (
  id         BIGSERIAL PRIMARY KEY,
  entry_id   UUID NOT NULL REFERENCES journal_entries(id),
  account_id UUID NOT NULL REFERENCES accounts(id),
  asset_id   TEXT NOT NULL REFERENCES assets(id),
  direction  TEXT NOT NULL CHECK (direction IN ('debit','credit')),
  amount     NUMERIC(78,0) NOT NULL CHECK (amount > 0),
  balance_after NUMERIC(78,0) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX postings_entry_idx   ON postings (entry_id);
CREATE INDEX postings_account_idx ON postings (account_id, id);

-- Regla de oro: por asiento y por activo, débitos = créditos (validado al COMMIT)
CREATE FUNCTION check_entry_balanced() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE bad TEXT;
BEGIN
  SELECT asset_id INTO bad FROM postings WHERE entry_id = NEW.entry_id
   GROUP BY asset_id
  HAVING SUM(CASE direction WHEN 'debit' THEN amount ELSE -amount END) <> 0
   LIMIT 1;
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'Asiento % descuadrado en activo %', NEW.entry_id, bad USING ERRCODE = 'P0001';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER postings_balanced
  AFTER INSERT ON postings DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION check_entry_balanced();

-- La partida debe usar el activo de su cuenta
CREATE FUNCTION check_posting_asset() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.asset_id <> (SELECT asset_id FROM accounts WHERE id = NEW.account_id) THEN
    RAISE EXCEPTION 'Activo de la partida no coincide con la cuenta' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER postings_asset BEFORE INSERT ON postings FOR EACH ROW EXECUTE FUNCTION check_posting_asset();

-- Libro inmutable: lo registrado se corrige con un asiento de reverso, nunca editando
CREATE FUNCTION forbid_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'El libro contable es inmutable (%.%)', TG_TABLE_NAME, TG_OP USING ERRCODE = 'P0001';
END $$;
CREATE TRIGGER postings_immutable BEFORE UPDATE OR DELETE ON postings FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER entries_immutable  BEFORE UPDATE OR DELETE ON journal_entries FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- Idempotencia de la API: misma llave + mismo cuerpo => misma respuesta
CREATE TABLE idempotency_keys (
  key           TEXT NOT NULL,
  scope         TEXT NOT NULL,                        -- huella de la API key del cliente + ruta
  request_hash  TEXT NOT NULL,
  status_code   INT,
  response_body JSONB,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at  TIMESTAMPTZ,
  PRIMARY KEY (scope, key)
);
`;
