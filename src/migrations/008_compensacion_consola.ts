// 008 — Compensación desde la consola: motivo y autor de cancelación de obligaciones,
//        autor de cada corrida e índices para historial y búsqueda por referencia (OC, factura, CFDI).
export default /* sql */ `
ALTER TABLE obligations
  ADD COLUMN cancel_reason TEXT,
  ADD COLUMN cancelled_at  TIMESTAMPTZ,
  ADD COLUMN cancelled_by  TEXT;

ALTER TABLE netting_runs ADD COLUMN created_by TEXT;   -- correo del operador o 'api:xxxx'

CREATE INDEX obligations_created_idx    ON obligations (created_at DESC, id DESC);
CREATE INDEX obligations_ext_ref_idx    ON obligations (external_ref) WHERE external_ref IS NOT NULL;
CREATE INDEX netting_runs_created_idx   ON netting_runs (created_at DESC, id DESC);
`;
