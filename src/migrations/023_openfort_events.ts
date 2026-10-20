// 023 — Eventos de webhook de Openfort (solo observación/conciliación; idempotentes por huella del cuerpo).
export default /* sql */ `
CREATE TABLE IF NOT EXISTS openfort_events (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  digest       TEXT NOT NULL UNIQUE,
  type         TEXT NOT NULL,
  event_date   BIGINT,
  tx_hashes    TEXT[] NOT NULL DEFAULT '{}',
  matched_kind TEXT,
  matched_id   UUID,
  payload      JSONB,
  received_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS openfort_events_received_idx ON openfort_events (received_at DESC);
`;
