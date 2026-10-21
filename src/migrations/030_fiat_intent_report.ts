// 030 - El cliente puede reportar en su aviso de pago que ya hizo la transferencia SEPA (fecha, referencia bancaria y nota).
// Es solo informativo para tesoreria: no cambia el estado del aviso ni acredita nada; la conciliacion sigue siendo por la
// referencia del aviso. Idempotente.
export default /* sql */ `
ALTER TABLE fiat_payment_intents ADD COLUMN IF NOT EXISTS reported_at timestamptz;
ALTER TABLE fiat_payment_intents ADD COLUMN IF NOT EXISTS reported_by text;
ALTER TABLE fiat_payment_intents ADD COLUMN IF NOT EXISTS reported_date date;
ALTER TABLE fiat_payment_intents ADD COLUMN IF NOT EXISTS reported_bank_ref text;
ALTER TABLE fiat_payment_intents ADD COLUMN IF NOT EXISTS reported_note text;
`;
