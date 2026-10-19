// 021 — Retiro de clientes: columnas que usa POST /v1/clients/:id/retire (faltaban → "Error interno").
export default /* sql */ `
ALTER TABLE clients
  ADD COLUMN IF NOT EXISTS retired_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS retired_by TEXT;
`;
