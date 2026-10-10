// Alta de operador de la consola desde la terminal (la contraseña se lee por stdin, nunca como argumento).
// Uso: node dist/scripts/create-operator.js <email> <rol: lectura|operador|tesorero> [nombre]
import { createInterface } from 'node:readline';
import { createOperator, ROLES, type Role } from '../auth/operators.js';
import { pool } from '../db.js';

const [email, role, ...name] = process.argv.slice(2);
if (!email || !ROLES.includes(role as Role)) {
  console.error('Uso: create-operator <email> <lectura|operador|tesorero> [nombre]');
  process.exit(1);
}
const rl = createInterface({ input: process.stdin, output: process.stderr, terminal: process.stdin.isTTY });
if (process.stdin.isTTY) {
  // Ocultar lo que se teclea
  (rl as unknown as { _writeToOutput: (s: string) => void })._writeToOutput = (s) => { if (s.includes('Contraseña')) process.stderr.write(s); };
}
const password: string = await new Promise((r) => rl.question('Contraseña (mín. 12): ', (a) => { rl.close(); r(a); }));
process.stderr.write('\n');
try {
  const o = await createOperator({ email, role: role as Role, name: name.join(' ') || email.split('@')[0], password });
  console.log(`Operador creado: ${o.email} (${o.role}) ${o.id}`);
} catch (e) {
  console.error('Error:', (e as Error).message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
