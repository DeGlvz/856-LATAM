// 010 — Reemplazo de transacciones atascadas (gas bump): mismo nonce, comisiones más altas.
// Se registran TODOS los intentos de envío: cualquiera de ellos puede ser el que se mine.
export default /* sql */ `
CREATE TABLE tx_attempts (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  kind                     TEXT NOT NULL CHECK (kind IN ('withdrawal','sweep')),
  ref_id                   UUID NOT NULL,                 -- withdrawals.id o sweeps.id
  from_address             TEXT NOT NULL,
  nonce                    BIGINT NOT NULL,
  tx_hash                  TEXT NOT NULL UNIQUE,
  raw_tx                   TEXT NOT NULL,
  max_fee_per_gas          NUMERIC(78,0) NOT NULL,
  max_priority_fee_per_gas NUMERIC(78,0) NOT NULL,
  reason                   TEXT NOT NULL CHECK (reason IN ('original','bump','manual')),
  requested_by             TEXT,                          -- operador en aceleraciones manuales
  sent_at                  TIMESTAMPTZ,
  error                    TEXT,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX tx_attempts_ref_idx ON tx_attempts (kind, ref_id, created_at);

ALTER TABLE withdrawals ADD COLUMN broadcast_at TIMESTAMPTZ, ADD COLUMN bumps INT NOT NULL DEFAULT 0;
ALTER TABLE sweeps      ADD COLUMN broadcast_at TIMESTAMPTZ, ADD COLUMN bumps INT NOT NULL DEFAULT 0;
-- Lo que ya estaba en vuelo cuenta desde su última actualización
UPDATE withdrawals SET broadcast_at = updated_at WHERE status = 'broadcast';
UPDATE sweeps      SET broadcast_at = updated_at WHERE status = 'broadcast';
`;
