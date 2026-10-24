// Crea un tesorero de prueba con 2FA y expone aprobaciones con un código nuevo en cada llamada.
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { totp } from './totp.mjs';

export async function makeApprover({ BASE, ip, tag, env = process.env }) {
  const email = `aprob-${tag}@ejemplo.mx`, password = 'clave-aprobador-123';
  execFileSync('node', ['dist/scripts/create-operator.js', email, 'tesorero'], { input: password + '\n', env, stdio: ['pipe', 'pipe', 'pipe'] });
  let cookie = null;
  const call = async (method, path, body, extra = {}) => {
    const r = await fetch(BASE + path, { method, headers: { 'x-forwarded-for': ip, 'content-type': 'application/json', ...(cookie ? { cookie } : {}), ...(method !== 'GET' ? { 'x-856-console': '1' } : {}), ...extra }, body: body && JSON.stringify(body) });
    const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
    return { status: r.status, body: await r.json().catch(() => null) };
  };
  const login = await call('POST', '/v1/auth/login', { email, password });
  assert.equal(login.status, 200, JSON.stringify(login.body));
  const setup = await call('POST', '/v1/auth/totp/setup', {});
  assert.equal(setup.status, 200, JSON.stringify(setup.body));
  const { secret } = setup.body;
  const otp = totp(secret);
  const enabled = await call('POST', '/v1/auth/totp/enable', { code: await otp.next() });
  assert.equal(enabled.status, 200, JSON.stringify(enabled.body));
  return {
    email, call, code: () => otp.next(),
    approveWithdrawal: async (id) => call('POST', `/v1/withdrawals/${id}/approve`, { code: await otp.next() }),
    approveRun: async (id) => call('POST', `/v1/netting/runs/${id}/approve`, { code: await otp.next() }),
  };
}
