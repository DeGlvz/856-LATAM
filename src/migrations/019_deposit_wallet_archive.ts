// 019 — ocultar direcciones de depósito históricas sin dejar de monitorearlas.
export default /* sql */ `
ALTER TABLE wallets ADD COLUMN archived_at TIMESTAMPTZ;
ALTER TABLE wallets ADD COLUMN archived_by TEXT;
`;
