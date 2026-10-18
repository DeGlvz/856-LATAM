// 017 — cuentas fiat aisladas por cliente/proveedor, inbox de webhooks y claves de idempotencia.
// No cambia el flujo treasury ni convierte la conciliación en una acreditación.
export default /* sql */ `
ALTER TABLE wallets DROP CONSTRAINT IF EXISTS wallets_purpose_check;
ALTER TABLE wallets ADD CONSTRAINT wallets_purpose_check
  CHECK (purpose IN ('master_hot','master_cold','deposit','withdrawal_whitelist','fiat_treasury','fiat_client'));
ALTER TABLE wallets DROP CONSTRAINT IF EXISTS wallets_fiat_client_has_client;
ALTER TABLE wallets ADD CONSTRAINT wallets_fiat_client_has_client
  CHECK (purpose <> 'fiat_client' OR client_id IS NOT NULL);

ALTER TABLE fiat_accounts DROP CONSTRAINT IF EXISTS fiat_accounts_provider_check;
ALTER TABLE fiat_accounts ADD CONSTRAINT fiat_accounts_provider_check
  CHECK (provider IN ('monerium','mock','transak','circle'));
ALTER TABLE fiat_accounts DROP CONSTRAINT IF EXISTS fiat_accounts_check;
ALTER TABLE fiat_accounts DROP CONSTRAINT IF EXISTS fiat_accounts_client_mode_check;
ALTER TABLE fiat_accounts ADD CONSTRAINT fiat_accounts_client_mode_check
  CHECK ((mode = 'treasury' AND client_id IS NULL) OR (mode = 'per_client' AND client_id IS NOT NULL));

DROP INDEX IF EXISTS fiat_accounts_treasury_idx;
CREATE UNIQUE INDEX IF NOT EXISTS fiat_accounts_treasury_network_idx
  ON fiat_accounts (provider, network) WHERE mode = 'treasury' AND status <> 'closed';
CREATE UNIQUE INDEX IF NOT EXISTS fiat_accounts_client_network_open_idx
  ON fiat_accounts (client_id, network) WHERE mode = 'per_client' AND status <> 'closed';
CREATE UNIQUE INDEX IF NOT EXISTS fiat_accounts_address_idx ON fiat_accounts (network, address);

ALTER TABLE fiat_payment_intents ADD COLUMN IF NOT EXISTS fiat_account_id UUID;
ALTER TABLE fiat_payment_intents ADD COLUMN IF NOT EXISTS provider TEXT;
UPDATE fiat_payment_intents i
   SET fiat_account_id = a.id, provider = a.provider
  FROM fiat_accounts a
 WHERE i.fiat_account_id IS NULL AND a.mode = 'treasury' AND a.status <> 'closed'
   AND (SELECT count(*) FROM fiat_accounts current_accounts
         WHERE current_accounts.mode = 'treasury' AND current_accounts.status <> 'closed') = 1;
CREATE INDEX IF NOT EXISTS fiat_intents_account_idx ON fiat_payment_intents (fiat_account_id, client_id, created_at DESC);

ALTER TABLE fiat_deposits DROP CONSTRAINT IF EXISTS fiat_deposits_provider_provider_order_id_key;
ALTER TABLE fiat_deposits ADD COLUMN IF NOT EXISTS idempotency_key TEXT;
UPDATE fiat_deposits
   SET idempotency_key = encode(digest(provider || provider_order_id || COALESCE(client_id::text, ''), 'sha256'), 'hex')
 WHERE idempotency_key IS NULL;
ALTER TABLE fiat_deposits ALTER COLUMN idempotency_key SET NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS fiat_deposits_account_order_idx ON fiat_deposits (fiat_account_id, provider_order_id);
CREATE UNIQUE INDEX IF NOT EXISTS fiat_deposits_idempotency_idx ON fiat_deposits (idempotency_key);
ALTER TABLE fiat_deposits DROP CONSTRAINT IF EXISTS fiat_deposits_match_rule_check;
ALTER TABLE fiat_deposits ADD CONSTRAINT fiat_deposits_match_rule_check
  CHECK (match_rule IN ('intent','counterparty','manual','account'));
CREATE INDEX IF NOT EXISTS fiat_deposits_account_status_idx ON fiat_deposits (fiat_account_id, status, received_at);

CREATE TABLE IF NOT EXISTS fiat_webhook_events (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider         TEXT NOT NULL CHECK (provider IN ('monerium','mock','transak','circle')),
  external_event_id TEXT NOT NULL,
  payload_sha256   TEXT NOT NULL CHECK (payload_sha256 ~ '^[0-9a-f]{64}$'),
  order_ids        JSONB NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(order_ids) = 'array'),
  verified         BOOLEAN NOT NULL CHECK (verified),
  received_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (provider, external_event_id)
);

CREATE OR REPLACE FUNCTION validate_fiat_account_links() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  a fiat_accounts%ROWTYPE;
  i fiat_payment_intents%ROWTYPE;
BEGIN
  SELECT * INTO a FROM fiat_accounts WHERE id = NEW.fiat_account_id;
  IF NOT FOUND OR NEW.provider <> a.provider THEN
    RAISE EXCEPTION 'fiat deposit provider/account mismatch' USING ERRCODE = '23514';
  END IF;
  IF a.mode = 'per_client' THEN
    IF NEW.client_id IS NULL THEN NEW.client_id := a.client_id; END IF;
    IF NEW.client_id <> a.client_id THEN
      RAISE EXCEPTION 'fiat deposit client/account mismatch' USING ERRCODE = '23514';
    END IF;
    IF NEW.idempotency_key <> encode(digest(NEW.provider || NEW.provider_order_id || a.client_id::text, 'sha256'), 'hex') THEN
      RAISE EXCEPTION 'fiat deposit idempotency key does not bind provider/order/client' USING ERRCODE = '23514';
    END IF;
    IF TG_OP = 'UPDATE' AND OLD.client_id IS DISTINCT FROM a.client_id THEN
      RAISE EXCEPTION 'per-client fiat deposit ownership is immutable' USING ERRCODE = '23514';
    END IF;
  END IF;
  IF NEW.intent_id IS NOT NULL THEN
    SELECT * INTO i FROM fiat_payment_intents WHERE id = NEW.intent_id;
    IF NOT FOUND OR i.client_id IS DISTINCT FROM NEW.client_id
       OR (i.fiat_account_id IS NOT NULL AND i.fiat_account_id <> NEW.fiat_account_id)
       OR (i.provider IS NOT NULL AND i.provider <> NEW.provider) THEN
      RAISE EXCEPTION 'fiat payment intent ownership/account mismatch' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS fiat_deposits_validate_links ON fiat_deposits;
CREATE TRIGGER fiat_deposits_validate_links
  BEFORE INSERT OR UPDATE OF fiat_account_id, provider, client_id, intent_id ON fiat_deposits
  FOR EACH ROW EXECUTE FUNCTION validate_fiat_account_links();

CREATE OR REPLACE FUNCTION validate_fiat_intent_account() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  a fiat_accounts%ROWTYPE;
BEGIN
  IF NEW.fiat_account_id IS NULL THEN RETURN NEW; END IF;
  SELECT * INTO a FROM fiat_accounts WHERE id = NEW.fiat_account_id;
  IF NOT FOUND OR (NEW.provider IS NOT NULL AND NEW.provider <> a.provider)
     OR (a.mode = 'per_client' AND a.client_id IS DISTINCT FROM NEW.client_id) THEN
    RAISE EXCEPTION 'fiat intent ownership/account mismatch' USING ERRCODE = '23514';
  END IF;
  NEW.provider := a.provider;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS fiat_intents_validate_account ON fiat_payment_intents;
CREATE TRIGGER fiat_intents_validate_account
  BEFORE INSERT OR UPDATE OF fiat_account_id, provider, client_id ON fiat_payment_intents
  FOR EACH ROW EXECUTE FUNCTION validate_fiat_intent_account();
`;
