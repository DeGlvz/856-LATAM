import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { Writable } from 'node:stream';
import { encrypt, generateSecrets, writeKeystore } from './keystore.js';
import { createSignerService } from './server.js';

/**
 * CLI del firmante:
 *   node dist/signer-service/main.js init [--show-mnemonic]   genera llaves NUEVAS y el almacén cifrado
 *   node dist/signer-service/main.js serve                    arranca el servicio (bloqueado)
 *   node dist/signer-service/main.js unlock | lock | status   administración local
 */

const env = (k: string, d?: string) => {
  const v = process.env[k] ?? d;
  if (v === undefined) throw new Error(`Falta la variable ${k}`);
  return v;
};
const KEYSTORE = () => env('SIGNER_KEYSTORE', '/var/lib/856-signer/keystore.json');
const ADMIN_PORT = () => Number(env('SIGNER_ADMIN_PORT', '8444'));

async function ask(question: string): Promise<string> {
  let muted = false;
  const out = new Writable({ write(chunk, _enc, cb) { if (!muted) process.stdout.write(chunk); cb(); } });
  const rl = createInterface({ input: process.stdin, output: out, terminal: true });
  return new Promise((resolve) => {
    rl.question(question, (a) => { rl.close(); process.stdout.write('\n'); resolve(a); });
    muted = true;
  });
}

async function adminCall(method: 'GET' | 'POST', path: string, body?: unknown) {
  const res = await fetch(`http://127.0.0.1:${ADMIN_PORT()}${path}`, {
    method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined,
  });
  const j = await res.json();
  if (!res.ok) throw new Error(j.error ?? res.statusText);
  return j;
}

async function main() {
  const cmd = process.argv[2];
  if (cmd === 'init') {
    const p1 = await ask('Contraseña del almacén (mín. 16 caracteres): ');
    const p2 = await ask('Repite la contraseña: ');
    if (p1 !== p2) throw new Error('Las contraseñas no coinciden');
    const s = generateSecrets();
    const f = encrypt(s, p1);
    writeKeystore(KEYSTORE(), f);
    console.log(`Almacén creado: ${KEYSTORE()}`);
    console.log(`Hot wallet (SIGNER_REMOTE_HOT_ADDRESS): ${f.hot}`);
    console.log(`xpub m/44'/60'/0'/0 (DEPOSIT_HD_XPUB):    ${f.xpub}`);
    if (process.argv.includes('--show-mnemonic')) {
      console.log('\nFRASE DE RESPALDO (24 palabras). Escríbela en papel y guárdala fuera de línea. No la copies a ningún chat ni archivo:');
      console.log(s.mnemonic);
      console.log('\nLa llave de la hot wallet está dentro del almacén cifrado; respalda keystore.json fuera de línea junto con la contraseña.');
    }
    return;
  }
  if (cmd === 'serve') {
    const secret = process.env.SIGNER_SECRET_FILE ? readFileSync(process.env.SIGNER_SECRET_FILE, 'utf8').trim() : env('SIGNER_SECRET');
    if (secret.length < 32) throw new Error('El secreto compartido debe tener al menos 32 caracteres');
    const svc = createSignerService({
      keystorePath: KEYSTORE(),
      policyPath: env('SIGNER_POLICY', '/etc/856-signer/policy.json'),
      secret,
      ledgerPath: env('SIGNER_LEDGER', '/var/lib/856-signer/ledger.json'),
      auditPath: env('SIGNER_AUDIT', '/var/lib/856-signer/audit.jsonl'),
      pausePath: env('SIGNER_PAUSE_FILE', '/etc/856-signer/PAUSE'),
    });
    const [host, port] = env('SIGNER_BIND').split(':');
    svc.api.listen(Number(port), host, () => console.log(`firmante escuchando en ${host}:${port} (bloqueado: ${svc.isLocked()}) hot=${svc.info().hot}`));
    svc.admin.listen(ADMIN_PORT(), '127.0.0.1', () => console.log(`administración local en 127.0.0.1:${ADMIN_PORT()}`));
    return;
  }
  if (cmd === 'unlock') { console.log(await adminCall('POST', '/admin/unlock', { passphrase: await ask('Contraseña del almacén: ') })); return; }
  if (cmd === 'lock') { console.log(await adminCall('POST', '/admin/lock')); return; }
  if (cmd === 'status') { console.log(await adminCall('GET', '/admin/status')); return; }
  console.log('Uso: main.js init [--show-mnemonic] | serve | unlock | lock | status');
  process.exit(2);
}

main().catch((e) => { console.error((e as Error).message); process.exit(1); });
