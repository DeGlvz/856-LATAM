// E2E multi-red EVM (ola 1) y activos habilitados por cliente, contra DOS cadenas locales simultáneas.
// Uso: BASE KEY DATABASE_URL RPC_URL RPC_B FUNDER_PK SIGNER_PK TOKEN node test/multired.e2e.mjs
//   API con NETWORKS=eth-sepolia,base-sepolia, RPC_URL (red A, chainId 31337) y RPC_URL_BASE_SEPOLIA (red B, chainId 31338),
//   ALCHEMY_WEBHOOK_SIGNING_KEY (A) y ALCHEMY_WEBHOOK_SIGNING_KEY_BASE_SEPOLIA (B), ORIGIN_RULE=off, WORKER_ENABLED=false.
//   El token de prueba (TOKEN) está desplegado en la MISMA dirección en ambas cadenas: sirve para probar el aislamiento.
import { createHmac, randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import pg from 'pg';
import { createPublicClient, createWalletClient, erc20Abi, http, parseEther } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { makeApprover } from './lib/approver.mjs';

const { BASE, KEY, DATABASE_URL, RPC_URL, RPC_B, FUNDER_PK, SIGNER_PK, TOKEN } = process.env;
const WH_A = process.env.ALCHEMY_WEBHOOK_SIGNING_KEY, WH_B = process.env.ALCHEMY_WEBHOOK_SIGNING_KEY_BASE_SEPOLIA;
const R = Math.random().toString(36).slice(2, 8);
const NET = `10.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`;
let ok = 0, fail = 0;
const check = (n, got, want) => { if (String(got) === String(want)) { ok++; console.log('✔', n); } else { fail++; console.log(`✘ ${n} — esperado ${want}, obtenido ${got}`); } };
const db = new pg.Pool({ connectionString: DATABASE_URL });
const chainA = { id: 31337, name: 'A', nativeCurrency: { name: 'E', symbol: 'E', decimals: 18 }, rpcUrls: { default: { http: [RPC_URL] } } };
const chainB = { id: 31338, name: 'B', nativeCurrency: { name: 'E', symbol: 'E', decimals: 18 }, rpcUrls: { default: { http: [RPC_B] } } };
const pubA = createPublicClient({ chain: chainA, transport: http() }), pubB = createPublicClient({ chain: chainB, transport: http() });
const funder = privateKeyToAccount(FUNDER_PK);
const walA = createWalletClient({ account: funder, chain: chainA, transport: http() }), walB = createWalletClient({ account: funder, chain: chainB, transport: http() });
const HOT = privateKeyToAccount(SIGNER_PK).address;
const ETH_A = 'ETH-SEPOLIA', ETH_B = 'ETH-BASE-SEPOLIA';
let TUSD_B = `TUSDB${R.toUpperCase()}`;

const api = async (method, path, body, idem) => {
  const r = await fetch(BASE + path, { method, headers: { 'x-api-key': KEY, 'content-type': 'application/json', ...(idem ? { 'idempotency-key': `${idem}-${R}` } : {}) }, body: body && JSON.stringify(body) });
  return { status: r.status, body: await r.json().catch(() => null) };
};
const webhook = async (key, hash) => {
  const raw = JSON.stringify({ id: `wh-${R}`, type: 'ADDRESS_ACTIVITY', event: { network: 'BASE_SEPOLIA', activity: [{ hash }] } });
  const sig = createHmac('sha256', key).update(raw, 'utf8').digest('hex');
  const r = await fetch(BASE + '/v1/webhooks/alchemy', { method: 'POST', headers: { 'content-type': 'application/json', 'x-alchemy-signature': sig }, body: raw });
  return { status: r.status, body: await r.json().catch(() => null) };
};
const tick = () => api('POST', '/v1/worker/tick');
function session(ip) {
  let cookie = null;
  const call = async (method, path, body) => {
    const r = await fetch(BASE + path, { method, headers: { 'x-forwarded-for': ip, 'content-type': 'application/json', ...(cookie ? { cookie } : {}), ...(method !== 'GET' ? { 'x-856-console': '1' } : {}) }, body: body && JSON.stringify(body) });
    const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
    return { status: r.status, body: await r.json().catch(() => null) };
  };
  return { call };
}

// ═════ Redes encendidas
const nets = (await api('GET', '/v1/networks')).body.networks;
check('dos redes encendidas con su chainId', nets.map((n) => `${n.id}:${n.chain_id}:${n.healthy}`).join(','), 'eth-sepolia:31337:true,base-sepolia:31338:true');
check('  …sin URL ni llaves en la vista', JSON.stringify(nets).includes('local-dummy-key') || JSON.stringify(nets).includes('whsec'), false);
const sum = (await api('GET', '/v1/summary')).body;
check('tablero: estado por red', sum.networks.map((n) => `${n.id}:${n.status}`).join(','), 'eth-sepolia:ok,base-sepolia:ok');

// ═════ Cliente con redes por defecto
const cl = (await api('POST', '/v1/clients', { name: `Multired ${R}`, assets: [ETH_A, ETH_B] }, 'cl')).body;
await api('PATCH', `/v1/clients/${cl.id}`, { status: 'active' });
let ca = (await api('GET', `/v1/clients/${cl.id}/assets`)).body.assets;
const st = (id) => ca.find((a) => a.asset_id === id);
check('activos de las 5 redes por defecto habilitados', ['ETH-SEPOLIA', 'USDC-ETH-SEPOLIA', 'EURC-ETH-SEPOLIA', 'ETH-BASE-SEPOLIA', 'USDC-ARB-SEPOLIA', 'POL-AMOY', 'BNB-TESTNET'].map((i) => st(i)?.status).join(), 'enabled,enabled,enabled,enabled,enabled,enabled,enabled');
check('  …las redes no encendidas se marcan', `${st('POL-AMOY').network_enabled} ${st('ETH-BASE-SEPOLIA').network_enabled}`, 'false true');

// ═════ Direcciones de depósito: la misma dirección EVM, registrada por red
const dA = (await api('POST', `/v1/clients/${cl.id}/deposit-address`, {})).body;
const dB = (await api('POST', `/v1/clients/${cl.id}/deposit-address`, { network: 'base-sepolia' })).body;
check('misma dirección en las dos redes', `${dA.network} ${dB.network} ${dA.address === dB.address}`, 'eth-sepolia base-sepolia true');
check('red no encendida → 422 network_not_supported', (await api('POST', `/v1/clients/${cl.id}/deposit-address`, { network: 'polygon-amoy' })).body?.code, 'network_not_supported');
const DEP = dA.address;

// ═════ Depósitos en cada red, acreditados por separado
await walB.sendTransaction({ to: HOT, value: parseEther('5') }); // gas de la hot wallet en la red B
const hB = await walB.sendTransaction({ to: DEP, value: parseEther('1') });
await pubB.waitForTransactionReceipt({ hash: hB });
const hA = await walA.sendTransaction({ to: DEP, value: parseEther('0.5') });
await pubA.waitForTransactionReceipt({ hash: hA });
check('webhook firmado con la llave de A no acredita una tx de B', (await webhook(WH_A, hB)).body?.deposits, 0);
check('firma inválida → 401', (await webhook('otra-llave', hB)).status, 401);
const wb = await webhook(WH_B, hB);
check('webhook con la llave de B detecta el depósito en B', `${wb.body?.network} ${wb.body?.deposits}`, 'base-sepolia 1');
const rA = await api('POST', '/v1/deposits/report', { tx_hash: hA });
check('reporte por hash sin red: lo encuentra en A', `${rA.status} ${rA.body.network} ${rA.body.deposits.length}`, '202 eth-sepolia 1');
const t1 = (await tick()).body;
check('el worker recorre ambas redes', JSON.stringify(t1.networks), JSON.stringify({ 'eth-sepolia': 'ok', 'base-sepolia': 'ok' }));
const bal = async () => Object.fromEntries((await db.query(`SELECT asset_id, balance::text FROM accounts WHERE client_id = $1`, [cl.id])).rows.map((r) => [r.asset_id, r.balance]));
let b = await bal();
check('saldos separados por red', `${b[ETH_A]} ${b[ETH_B]}`, `${parseEther('0.5')} ${parseEther('1')}`);
const deps = (await db.query(`SELECT network, status FROM deposits WHERE client_id = $1 ORDER BY network`, [cl.id])).rows;
check('cada depósito guarda su red', deps.map((d) => `${d.network}:${d.status}`).join(), 'base-sepolia:credited,eth-sepolia:credited');

// ═════ Retiros en ambas redes: nonces independientes por red
const DEST = `0x${randomBytes(20).toString('hex')}`;
await api('POST', '/v1/wallets', { client_id: cl.id, chain: 'ethereum', network: 'base-sepolia', address: DEST, purpose: 'withdrawal_whitelist' });
await api('POST', '/v1/wallets', { client_id: cl.id, chain: 'ethereum', network: 'eth-sepolia', address: DEST, purpose: 'withdrawal_whitelist' });
// Nonce on-chain antes de retirar (re-ejecutable sobre cadenas ya usadas)
const n0A = await pubA.getTransactionCount({ address: HOT, blockTag: 'pending' });
const n0B = await pubB.getTransactionCount({ address: HOT, blockTag: 'pending' });
await walA.sendTransaction({ to: HOT, value: parseEther('5') });
await api('POST', '/v1/entries', { kind: 'adjustment', description: 'fondeo de gas A', postings: [
  { account: `system:${ETH_A}:custody`, direction: 'debit', amount: parseEther('5').toString() }, { account: `system:${ETH_A}:equity`, direction: 'credit', amount: parseEther('5').toString() }] }, 'gasA');
await api('POST', '/v1/entries', { kind: 'adjustment', description: 'fondeo de gas B', postings: [
  { account: `system:${ETH_B}:custody`, direction: 'debit', amount: parseEther('5').toString() }, { account: `system:${ETH_B}:equity`, direction: 'credit', amount: parseEther('5').toString() }] }, 'gasB');
const wB = await api('POST', '/v1/withdrawals', { client_id: cl.id, asset_id: ETH_B, to_address: DEST, amount: parseEther('0.3').toString() }, 'wB');
const wA = await api('POST', '/v1/withdrawals', { client_id: cl.id, asset_id: ETH_A, to_address: DEST, amount: parseEther('0.2').toString() }, 'wA');
check('retiros solicitados en cada red', `${wB.status} ${wB.body.network} ${wA.status} ${wA.body.network}`, '202 base-sepolia 202 eth-sepolia');
await tick();
const gw = async (id) => (await api('GET', `/v1/withdrawals/${id}`)).body;
const xB = await gw(wB.body.id), xA = await gw(wA.body.id);
check('ambos confirmados', `${xB.status} ${xA.status}`, 'confirmed confirmed');
check('nonce de cada red sigue su propia secuencia', `${xB.nonce} ${xA.nonce}`, `${n0B} ${n0A}`);
check('el destino recibió en B lo de B', (await pubB.getBalance({ address: DEST })).toString(), parseEther('0.3').toString());
check('  …y en A lo de A', (await pubA.getBalance({ address: DEST })).toString(), parseEther('0.2').toString());
check('explorador y confirmaciones según la red', `${xB.required_confirmations} ${xB.explorer}`, '1 https://sepolia.basescan.org');

// ═════ Activo en «solo salida»: no recibe, sí retira
check('deshabilitar con saldo → 409 asset_in_use', (await api('PUT', `/v1/clients/${cl.id}/assets/${ETH_B}`, { status: 'disabled' })).body?.code, 'asset_in_use');
check('pasar a solo salida', (await api('PUT', `/v1/clients/${cl.id}/assets/${ETH_B}`, { status: 'exit_only' })).body.assets.find((a) => a.asset_id === ETH_B).status, 'exit_only');
const hB2 = await walB.sendTransaction({ to: DEP, value: parseEther('0.4') });
await pubB.waitForTransactionReceipt({ hash: hB2 });
await webhook(WH_B, hB2);
await tick();
const held = (await db.query(`SELECT id, status, held_reason FROM deposits WHERE tx_hash = $1`, [hB2.toLowerCase()])).rows[0];
check('depósito en un activo en solo salida queda en revisión', `${held.status} ${held.held_reason}`, 'held activo no habilitado para el cliente');
check('  …el tablero lo cuenta', (await api('GET', '/v1/summary')).body.approvals_pending.deposits_held >= 1, true);
b = await bal();
check('  …y no se acredita', b[ETH_B], (parseEther('1') - parseEther('0.3')).toString());
check('en solo salida sí puede retirar', (await api('POST', '/v1/withdrawals', { client_id: cl.id, asset_id: ETH_B, to_address: DEST, amount: '1000' }, 'wB2')).status, 202);
const rel = await api('POST', `/v1/deposits/${held.id}/release`, {});
check('tesorería libera el depósito en revisión → acreditado', rel.body.status, 'credited');
check('  …liberar otra vez → 409', (await api('POST', `/v1/deposits/${held.id}/release`, {})).body?.code, 'not_held');

// ═════ Activo no habilitado y solicitud del ejecutivo
const ta = await api('POST', '/v1/assets', { id: TUSD_B, symbol: 'TUSD', chain: 'ethereum', network: 'base-sepolia', kind: 'erc20', contract_address: TOKEN, decimals: 6 });
if (ta.status === 409) { // corrida previa: el token ya existe en B y el cliente lo recibió por defecto → se le quita
  TUSD_B = (await api('GET', '/v1/assets')).body.assets.find((a) => a.network === 'base-sepolia' && a.contract_address === TOKEN.toLowerCase()).id;
  await api('PUT', `/v1/clients/${cl.id}/assets/${TUSD_B}`, { status: 'disabled' });
}
check('alta de token de prueba en B (misma dirección que en A)', [201, 409].includes(ta.status), true);
check('retiro de un activo no habilitado → 403 asset_not_enabled',
  (await api('POST', '/v1/withdrawals', { client_id: cl.id, asset_id: TUSD_B, to_address: DEST, amount: '1' }, 'wT')).body?.code, 'asset_not_enabled');
const EJ = `mr-ejec-${R}@ejemplo.mx`;
execFileSync('node', ['dist/scripts/create-operator.js', EJ, 'ejecutivo'], { input: 'clave-ejecutivo-123\n', env: process.env, stdio: ['pipe', 'pipe', 'ignore'] });
const ej = session(`${NET}.30`);
await ej.call('POST', '/v1/auth/login', { email: EJ, password: 'clave-ejecutivo-123' });
check('el ejecutivo no cambia activos directamente → 403', (await ej.call('PUT', `/v1/clients/${cl.id}/assets/${TUSD_B}`, { status: 'enabled', code: '123456' })).status, 403);
const rq = await ej.call('POST', `/v1/clients/${cl.id}/asset-requests`, { asset_id: TUSD_B, action: 'enable', reason: 'El cliente opera TUSD en Base' });
check('el ejecutivo solicita habilitarlo → 201 pendiente', `${rq.status} ${rq.body.status}`, '201 pending');
check('  …una segunda solicitud igual → 409', (await ej.call('POST', `/v1/clients/${cl.id}/asset-requests`, { asset_id: TUSD_B, action: 'enable', reason: 'Otra vez la misma' })).body?.code, 'request_pending');
check('  …el ejecutivo no aprueba → 403', (await ej.call('POST', `/v1/asset-requests/${rq.body.id}/approve`, { code: '123456' })).status, 403);
const T1 = await makeApprover({ BASE, ip: `${NET}.20`, tag: `mr-${R}` });
check('tesorero sin 2FA de confirmación → 422', (await T1.call('POST', `/v1/asset-requests/${rq.body.id}/approve`, {})).body?.code, 'bad_code');
const ap = await T1.call('POST', `/v1/asset-requests/${rq.body.id}/approve`, { code: await T1.code() });
check('tesorero aprueba con 2FA → habilitado', `${ap.body.status} ${(await api('GET', `/v1/clients/${cl.id}/assets`)).body.assets.find((a) => a.asset_id === TUSD_B).status}`, 'approved enabled');

// ═════ Token en la misma dirección en ambas redes: cada depósito se acredita en su activo
const hT = await walB.writeContract({ address: TOKEN, abi: erc20Abi, functionName: 'transfer', args: [DEP, 2_500_000n] });
await pubB.waitForTransactionReceipt({ hash: hT });
const wt = await webhook(WH_B, hT);
await tick();
const dT = (await db.query(`SELECT asset_id, network, status FROM deposits WHERE tx_hash = $1`, [hT.toLowerCase()])).rows[0];
check('token de B acreditado como activo de B (no el de A)', `${wt.body.deposits} ${dT.asset_id === TUSD_B} ${dT.network} ${dT.status}`, '1 true base-sepolia credited');

// ═════ Bitácora, migración idempotente
const { rows: logs } = await db.query(`SELECT count(*)::int AS n FROM audit_log WHERE action LIKE '%asset-requests%'`);
check('bitácora: solicitud y aprobación', logs[0].n >= 2, true);
const m015 = (await import(new URL('../dist/migrations/015_multired.js', import.meta.url))).default;
let reRun = 'ok';
try { await db.query(m015); await db.query(m015); } catch (e) { reRun = e.message; }
check('migración 015 se re-ejecuta sin error', reRun, 'ok');

await db.end();
console.log(`\n${ok} ok, ${fail} fallos`);
process.exit(fail ? 1 : 0);
