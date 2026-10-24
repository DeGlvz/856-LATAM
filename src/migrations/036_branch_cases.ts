// 036 - Terminal de Caja / Branch Case: operaciones preparadas en sucursal por un ejecutivo, firmadas por el cliente
// (mandato) y liberadas por tesorería. Nada toca el libro hasta la aprobación; el apply es una sola transacción.
// payload_json/payload_hash son inmutables fuera de 'draft'. Idempotente.
// (La 035 ya está ocupada por 035_hd_generation.)
export default /* sql */ `
CREATE TABLE IF NOT EXISTS branch_cases (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id               UUID NOT NULL REFERENCES clients(id),
  created_by              UUID NOT NULL REFERENCES operators(id),
  created_by_email        TEXT NOT NULL,
  status                  TEXT NOT NULL DEFAULT 'draft'
                          CHECK (status IN ('draft','pending_client','pending_treasury','applied','rejected','cancelled')),
  kind                    TEXT NOT NULL CHECK (kind IN ('fund_load','internal_transfer','payment_order','mixed')),
  payload_json            JSONB NOT NULL,
  payload_hash            TEXT NOT NULL CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
  idempotency_key         TEXT,
  mandate_ref             TEXT,
  verbal_reason           TEXT,
  client_required         BOOLEAN NOT NULL DEFAULT true,
  client_signed_at        TIMESTAMPTZ,
  client_signer_user_id   UUID REFERENCES client_users(id),
  client_signature        TEXT,
  treasury_required       BOOLEAN NOT NULL DEFAULT true,
  treasury_approved_by    UUID REFERENCES operators(id),
  treasury_approved_at    TIMESTAMPTZ,
  applied_entry_ids       UUID[] NOT NULL DEFAULT '{}',
  applied_obligation_ids  UUID[] NOT NULL DEFAULT '{}',
  applied_transfer_ids    UUID[] NOT NULL DEFAULT '{}',
  last_error              TEXT,
  reject_reason           TEXT,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS branch_cases_idem_idx ON branch_cases (idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS branch_cases_client_idx ON branch_cases (client_id, created_at DESC);
CREATE INDEX IF NOT EXISTS branch_cases_pending_idx ON branch_cases (status, created_at DESC) WHERE status IN ('pending_client','pending_treasury');

CREATE TABLE IF NOT EXISTS branch_case_lines (
  branch_case_id    UUID NOT NULL REFERENCES branch_cases(id) ON DELETE CASCADE,
  line_no           INT NOT NULL CHECK (line_no > 0),
  op_type           TEXT NOT NULL CHECK (op_type IN ('credit_available','internal_transfer','payment_order','debit_adjustment')),
  asset_id          TEXT NOT NULL REFERENCES assets(id),
  amount            TEXT NOT NULL CHECK (amount ~ '^[1-9][0-9]{0,77}$'),
  from_account_ref  TEXT,
  to_account_ref    TEXT,
  counterparty_code TEXT,
  external_ref      TEXT,
  due_at            TIMESTAMPTZ,
  memo              TEXT,
  status            TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','applied','skipped','failed')),
  result_ref        TEXT,
  PRIMARY KEY (branch_case_id, line_no)
);

CREATE OR REPLACE FUNCTION branch_cases_guard_payload() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status <> 'draft' AND (NEW.payload_json IS DISTINCT FROM OLD.payload_json OR NEW.payload_hash IS DISTINCT FROM OLD.payload_hash) THEN
    RAISE EXCEPTION 'branch_case payload is immutable once submitted' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS branch_cases_payload_guard ON branch_cases;
CREATE TRIGGER branch_cases_payload_guard BEFORE UPDATE ON branch_cases
  FOR EACH ROW EXECUTE FUNCTION branch_cases_guard_payload();

-- Las líneas solo cambian de contenido mientras el caso es borrador; después solo avanzan status/result_ref
CREATE OR REPLACE FUNCTION branch_case_lines_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE st TEXT;
BEGIN
  SELECT status INTO st FROM branch_cases WHERE id = COALESCE(NEW.branch_case_id, OLD.branch_case_id);
  IF st IS NULL OR st = 'draft' THEN RETURN COALESCE(NEW, OLD); END IF;
  IF TG_OP = 'UPDATE' AND ROW(NEW.branch_case_id, NEW.line_no, NEW.op_type, NEW.asset_id, NEW.amount, NEW.from_account_ref,
      NEW.to_account_ref, NEW.counterparty_code, NEW.external_ref, NEW.due_at, NEW.memo)
    IS NOT DISTINCT FROM ROW(OLD.branch_case_id, OLD.line_no, OLD.op_type, OLD.asset_id, OLD.amount, OLD.from_account_ref,
      OLD.to_account_ref, OLD.counterparty_code, OLD.external_ref, OLD.due_at, OLD.memo) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'branch_case lines are immutable once submitted' USING ERRCODE = '23514';
END $$;
DROP TRIGGER IF EXISTS branch_case_lines_guard ON branch_case_lines;
CREATE TRIGGER branch_case_lines_guard BEFORE INSERT OR UPDATE OR DELETE ON branch_case_lines
  FOR EACH ROW EXECUTE FUNCTION branch_case_lines_guard();

-- Obligaciones originadas por mandato de sucursal (el cliente es el deudor y firmó el caso)
ALTER TABLE obligations DROP CONSTRAINT IF EXISTS obligations_origin_kind_check;
ALTER TABLE obligations ADD CONSTRAINT obligations_origin_kind_check
  CHECK (origin_kind IN ('client_user','client_key','delegate','console','api','branch_mandate'));
CREATE UNIQUE INDEX IF NOT EXISTS obligations_branch_idem_idx ON obligations ((metadata->>'idempotency_key'))
  WHERE origin_kind = 'branch_mandate';
`;
