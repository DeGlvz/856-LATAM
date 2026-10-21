// 032 - Reenvio de acceso a operadores: un enlace de un solo uso ligado a un operador existente
// (operator_id) permite definir una contrasena nueva. Idempotente.
export default /* sql */ `
ALTER TABLE operator_invites ADD COLUMN IF NOT EXISTS operator_id UUID REFERENCES operators(id);
`;
