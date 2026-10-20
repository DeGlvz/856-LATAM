// 026 — Eliminación definitiva de rieles sin historial: solo se pueden borrar propuestas no aprobadas, y únicamente
// dentro de la transacción de eliminación (app.rail_delete = 'on'). Las cuentas aprobadas siguen siendo inmutables.
export default /* sql */ `
CREATE OR REPLACE FUNCTION fiat_rail_accounts_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF current_setting('app.rail_delete', true) = 'on' AND OLD.approved_by IS NULL THEN RETURN OLD; END IF;
    RAISE EXCEPTION 'fiat_rail_accounts es inmutable';
  END IF;
  IF NEW.rail_id IS DISTINCT FROM OLD.rail_id OR NEW.version IS DISTINCT FROM OLD.version
     OR NEW.details_enc IS DISTINCT FROM OLD.details_enc OR NEW.last4 IS DISTINCT FROM OLD.last4
     OR NEW.created_by IS DISTINCT FROM OLD.created_by OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR NEW.proposal_reason IS DISTINCT FROM OLD.proposal_reason OR NEW.changed_fields IS DISTINCT FROM OLD.changed_fields THEN
    RAISE EXCEPTION 'fiat_rail_accounts es inmutable: cree una versión nueva';
  END IF;
  RETURN NEW;
END $$;
`;
