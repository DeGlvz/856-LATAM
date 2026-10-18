// Crea un tesorero de prueba con 2FA y expone aprobaciones con un código nuevo en cada llamada.
import { execFileSync } from 'node:child_process';
import { totp } from './totp.mjs';

export async function makeApprover({ BASE, ip, tag }) {
  const email = `aprob-${tag}@ejemplo.mx`, password = 'clave-aprobador-123';
  execFileSync('node', ['dist/scripts/create-operator.js', email, 'tesorero'], { input: password + '\n', env: process.env, stdio: ['pipe', 'pipe', 'ignore'] });
  let cookie = null;
  const call = async (method, path, body) => {
    const r = await fetch(BASE + path, { method, headers: { 'x-forwarded-for': ip, 'content-type': 'application/json', ...(cookie ? { cookie } : {}), ...(method !== 'GET' ? { 'x-856-console': '1' } : {}) }, body: body && JSON.stringify(body) });
    const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
    return { status: r.status, body: await r.json().catch(() => null) };
  };
  await call('POST', '/v1/auth/login', { email, password });
  const { secret } = (await call('POST', '/v1/auth/totp/setup', {})).body;
  const otp = totp(secret);
  await call('POST', '/v1/auth/totp/enable', { code: await otp.next() });
  return {
    email, call, code: () => otp.next(),
    approveWithdrawal: async (id) => call('POST', `/v1/withdrawals/${id}/approve`, { code: await otp.next() }),
    approveRun: async (id) => call('POST', `/v1/netting/runs/${id}/approve`, { code: await otp.next() }),
  };
}
