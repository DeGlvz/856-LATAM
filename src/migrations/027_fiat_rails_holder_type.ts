// 027 — Tipo de titular de la cuenta (persona/empresa) visible sin descifrar: las cuentas personales obligan a visibilidad restringida.
export default /* sql */ `
ALTER TABLE fiat_rail_accounts ADD COLUMN IF NOT EXISTS holder_type TEXT CHECK (holder_type IN ('persona','empresa'));
`;
