// 020 — eliminación segura de usuarios del portal con atribución histórica preservada.
export default /* sql */ `
ALTER TABLE client_api_keys ALTER COLUMN created_by DROP NOT NULL;
ALTER TABLE client_api_keys ADD COLUMN IF NOT EXISTS created_by_email TEXT;
ALTER TABLE client_api_keys ADD COLUMN IF NOT EXISTS created_by_name TEXT;

ALTER TABLE obligations ADD COLUMN IF NOT EXISTS origin_user_email TEXT;
ALTER TABLE obligations ADD COLUMN IF NOT EXISTS origin_user_name TEXT;

ALTER TABLE exit_simulations ADD COLUMN IF NOT EXISTS origin_user_email TEXT;
ALTER TABLE exit_simulations ADD COLUMN IF NOT EXISTS origin_user_name TEXT;

ALTER TABLE withdrawals
  ADD COLUMN IF NOT EXISTS origin_user_email TEXT,
  ADD COLUMN IF NOT EXISTS origin_user_name TEXT,
  ADD COLUMN IF NOT EXISTS client_approved_by_email TEXT,
  ADD COLUMN IF NOT EXISTS client_approved_by_name TEXT;

ALTER TABLE wallets
  ADD COLUMN IF NOT EXISTS wl_requested_by_email TEXT,
  ADD COLUMN IF NOT EXISTS wl_requested_by_name TEXT,
  ADD COLUMN IF NOT EXISTS wl_approved_by_email TEXT,
  ADD COLUMN IF NOT EXISTS wl_approved_by_name TEXT;

ALTER TABLE client_approval_thresholds
  ADD COLUMN IF NOT EXISTS updated_by_email TEXT,
  ADD COLUMN IF NOT EXISTS updated_by_name TEXT;

CREATE OR REPLACE FUNCTION guard_client_user_origin() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  owner_id UUID;
  user_id UUID;
BEGIN
  IF NEW.origin_kind IS DISTINCT FROM 'client_user' THEN RETURN NEW; END IF;
  user_id := NEW.origin_ref::uuid;
  IF TG_TABLE_NAME = 'obligations' THEN
    owner_id := NEW.creditor_id;
  ELSE
    owner_id := NEW.client_id;
  END IF;
  PERFORM 1 FROM client_users WHERE id = user_id AND client_id = owner_id FOR KEY SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'client user origin does not exist for this client' USING ERRCODE = '23503';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER obligations_user_origin_guard
  BEFORE INSERT OR UPDATE OF origin_kind, origin_ref, creditor_id ON obligations
  FOR EACH ROW EXECUTE FUNCTION guard_client_user_origin();
CREATE TRIGGER exit_simulations_user_origin_guard
  BEFORE INSERT OR UPDATE OF origin_kind, origin_ref, client_id ON exit_simulations
  FOR EACH ROW EXECUTE FUNCTION guard_client_user_origin();
CREATE TRIGGER withdrawals_user_origin_guard
  BEFORE INSERT OR UPDATE OF origin_kind, origin_ref, client_id ON withdrawals
  FOR EACH ROW EXECUTE FUNCTION guard_client_user_origin();
CREATE TRIGGER fiat_intents_user_origin_guard
  BEFORE INSERT OR UPDATE OF origin_kind, origin_ref, client_id ON fiat_payment_intents
  FOR EACH ROW EXECUTE FUNCTION guard_client_user_origin();
`;
