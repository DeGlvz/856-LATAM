// 035 — generación de la semilla HD. Las direcciones existentes son la generación 1;
// al rotar la semilla se sube HD_GENERATION y solo la generación vigente se deriva, barre y liga.
export default /* sql */ `
ALTER TABLE wallets ADD COLUMN hd_generation INT NOT NULL DEFAULT 1;
`;
