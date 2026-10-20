// 025 — Rieles fiat manuales editables: archivado lógico (sin borrado físico).
export default /* sql */ `
ALTER TABLE fiat_rails ADD COLUMN IF NOT EXISTS is_archived BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE fiat_rails ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ;
`;
