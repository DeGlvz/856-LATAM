import test from 'node:test';
import assert from 'node:assert/strict';

process.env.ALCHEMY_API_KEY ??= 'unit-test-alchemy-key';
process.env.API_KEYS ??= 'unit-test-api-key';
process.env.DATABASE_URL ??= 'postgres://localhost/bootstrap_test';

const { loadSsmSecrets, bootstrap } = await import('../dist/secrets.js');

const fakeSsm = (pages) => {
  const calls = [];
  return { calls, send: async (cmd) => { calls.push(cmd.input); return pages[calls.length - 1]; } };
};

test('carga /856/production/* paginado, con descifrado, sin sobrescribir lo definido', async () => {
  const ssm = fakeSsm([
    { Parameters: [{ Name: '/856/production/API_KEYS', Value: 'k1' }, { Name: '/856/production/DATABASE_URL', Value: 'postgres://x' }], NextToken: 't1' },
    { Parameters: [{ Name: '/856/production/ALCHEMY_API_KEY', Value: 'alchemy-from-ssm' }, { Name: '/856/production/sub/IGNORADO', Value: 'z' }] },
  ]);
  const env = { API_KEYS: 'ya-definida' };
  const names = await loadSsmSecrets(ssm, env);
  assert.equal(env.API_KEYS, 'ya-definida');
  assert.equal(env.DATABASE_URL, 'postgres://x');
  assert.equal(env.ALCHEMY_API_KEY, 'alchemy-from-ssm');
  assert.equal(env.IGNORADO, undefined);
  assert.deepEqual(names.sort(), ['ALCHEMY_API_KEY', 'DATABASE_URL']);
  assert.equal(ssm.calls[0].Path, '/856/production/');
  assert.equal(ssm.calls[0].WithDecryption, true);
  assert.equal(ssm.calls[1].NextToken, 't1');
});

test('SECRETS_SOURCE=ssm: carga antes de arrancar el servidor', async () => {
  const ssm = fakeSsm([{ Parameters: [{ Name: '/856/production/HD_MNEMONIC', Value: 'secreto' }] }]);
  const env = { SECRETS_SOURCE: 'ssm' };
  let seenAtStart;
  await bootstrap({ env, ssm, log: () => {}, start: async () => { seenAtStart = env.HD_MNEMONIC; } });
  assert.equal(seenAtStart, 'secreto');
});

test('sin SSM: no se consulta nada y el servidor arranca igual', async () => {
  const ssm = fakeSsm([]);
  const env = { FOO: 'bar' };
  let started = false;
  await bootstrap({ env, ssm, log: () => {}, start: async () => { started = true; } });
  assert.equal(started, true);
  assert.equal(ssm.calls.length, 0);
  assert.deepEqual(env, { FOO: 'bar' });
});

test('SSM sin parámetros o con error: el arranque falla y no inicia el servidor', async () => {
  let started = false;
  await assert.rejects(bootstrap({ env: { SECRETS_SOURCE: 'ssm' }, ssm: fakeSsm([{ Parameters: [] }]), log: () => {}, start: async () => { started = true; } }), /ningún parámetro/);
  await assert.rejects(bootstrap({ env: { SECRETS_SOURCE: 'ssm' }, ssm: { send: async () => { throw new Error('AccessDenied'); } }, log: () => {}, start: async () => { started = true; } }), /AccessDenied/);
  assert.equal(started, false);
});

test('SSM_PATH personalizado se respeta', async () => {
  const ssm = fakeSsm([{ Parameters: [{ Name: '/otra/X', Value: '1' }] }]);
  const env = {};
  await loadSsmSecrets(ssm, env, '/otra');
  assert.equal(ssm.calls[0].Path, '/otra/');
  assert.equal(env.X, '1');
});
