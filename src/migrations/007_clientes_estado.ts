// 007 — Ciclo de vida del cliente: motivo y fecha del último cambio de estado, y bloqueo de saldo
//        para clientes suspendidos o cerrados (no pueden disponer: ni retiros, ni transferencias, ni pagos netos).
export default /* sql */ `
ALTER TABLE clients
  ADD COLUMN status_reason     TEXT,
  ADD COLUMN status_changed_at TIMESTAMPTZ;

-- Un débito a la cuenta de un cliente reduce lo que le debemos = el cliente dispone de su saldo.
-- Los créditos (depósitos, reversos de retiros) siguen permitidos.
CREATE FUNCTION check_client_can_spend() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE st TEXT;
BEGIN
  IF NEW.direction = 'debit' THEN
    SELECT c.status INTO st FROM accounts a JOIN clients c ON c.id = a.client_id WHERE a.id = NEW.account_id;
    IF st IN ('suspended','closed') THEN
      RAISE EXCEPTION 'Cliente % no puede disponer de saldo (estado: %)', (SELECT client_id FROM accounts WHERE id = NEW.account_id), st
        USING ERRCODE = 'P0001';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER postings_client_status BEFORE INSERT ON postings FOR EACH ROW EXECUTE FUNCTION check_client_can_spend();
`;
