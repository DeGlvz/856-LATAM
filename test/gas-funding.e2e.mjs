// E2E registro de gas en el libro: fondeo de la hot wallet verificado en cadena, idempotente, solo tesorero con 2FA,
// y un barrido detenido por falta de custodia nativa que se liquida al registrar el fondeo.
// Uso: BASE KEY RPC_URL TOKEN FUNDER_PK SIGNER_PK node test/gas-funding.e2e.mjs (API local con WORKER_ENABLED=true, intervalo 1000 ms)
import { execFileSync } from 'node:child_process';
import { createPublicClient, createWalletClient, http, erc20Abi, parseEther } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { localChain, workerDriver } from './lib/worker.mjs';
import { makeApprover } from './lib/approver.mjs';

const { BASE, KEY, RPC_URL, TOKEN, FUNDER_PK, SIGNER_PK } = process.env;
const hardhat = await localChain(RPC_URL);
const pub = createPublicClient({ chain: hardhat, transport: http(RPC_URL) });
const funder = createWalletClient({ account: privateKeyToAccount(FUNDER_PK), chain: hardhat, transport: http(RPC_URL) });
const hotW = createWalletClient({ account: privateKeyToAccount(SIGNER_PK), chain: hardhat, transport: http(RPC_URL) });
const R = Math.random().toString(36).slice(2, 8);
const NET = `10.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`;
let ok = 0, fail = 0;
const check = (n, got, want) => { if (String(got) === String(want)) { ok++; console.log('✔', n); } else { fail++; console.log(`✘ ${n} — esperado ${want}, obtenido ${got}`); } };
const api = async (method, path, body, idem) => {
  const r = await fetch(BASE + path, { method, headers: { 'x-api-key': KEY, 'content-type': 'application/json', ...(idem ? { 'idempotency-key': `${idem}-${R}` } : {}) }, body: body && JSON.stringify(body) });
  return { status: r.status, body: await r.json().catch(() => null) };
};
const wait = (h) => pub.waitForTransactionReceipt({ hash: h });
const mine = async (n) => { for (let i = 0; i < n; i++) await pub.request({ method: 'evm_mine', params: [] }); };
const worker = workerDriver({ BASE, KEY, allowSettlementError: true });
const tick = () => worker.run(cl.id);
const custody = async () => (await api('GET', '/v1/accounts/system:ETH-SEPOLIA:custody')).body.balance;
const netRow = async () => (await api('GET', '/v1/summary')).body.networks.find((n) => n.id === 'eth-sepolia');
const NETWORK = 'eth-sepolia';

const HOT = privateKeyToAccount(SIGNER_PK).address;
const T1 = await makeApprover({ BASE, ip: `${NET}.20`, tag: `gas-${R}` });
const EJ = `ejec-gas-${R}@ejemplo.mx`;
execFileSync('node', ['dist/scripts/create-operator.js', EJ, 'ejecutivo'], { input: 'clave-ejecutivo-123\n', env: process.env, stdio: ['pipe', 'pipe', 'ignore'] });
let ejCookie = null;
const ej = async (method, path, body) => {
  const r = await fetch(BASE + path, { method, headers: { 'x-forwarded-for': `${NET}.21`, 'content-type': 'application/json', ...(ejCookie ? { cookie: ejCookie } : {}), ...(method !== 'GET' ? { 'x-856-console': '1' } : {}) }, body: body && JSON.stringify(body) });
  const sc = r.headers.get('set-cookie'); if (sc) ejCookie = sc.split(';')[0];
  return { status: r.status, body: await r.json().catch(() => null) };
};
await ej('POST', '/v1/auth/login', { email: EJ, password: 'clave-ejecutivo-123' });
const confs = (await api('GET', '/v1/networks')).body.networks.find((n) => n.id === NETWORK).confirmations;

// ═════ 1. Barrido detenido: la custodia nativa del libro queda en cero y un barrido necesita registrar gas
const c0 = BigInt(await custody());
if (c0 > 0n) await api('POST', '/v1/entries', { kind: 'adjustment', postings: [
  { account: 'system:ETH-SEPOLIA:equity', direction: 'debit', amount: c0.toString() },
  { account: 'system:ETH-SEPOLIA:custody', direction: 'credit', amount: c0.toString() }] }, 'drain');
check('custodia nativa del libro en cero (gas sin registrar)', await custody(), '0');
let TUSD = `TUSD-G${R.toUpperCase().slice(0, 5)}`;
const ra = await api('POST', '/v1/assets', { id: TUSD, symbol: 'TUSD', chain: 'ethereum', network: NETWORK, kind: 'erc20', contract_address: TOKEN, decimals: 6 });
if (ra.status === 409) TUSD = (await api('GET', '/v1/assets')).body.assets.find((a) => a.contract_address === TOKEN.toLowerCase() && a.network === NETWORK).id;
const cl = (await api('POST', '/v1/clients', { name: `Gas ${R}`, assets: [TUSD, 'ETH-SEPOLIA'] }, 'cl')).body;
await api('PATCH', `/v1/clients/${cl.id}`, { status: 'active' });
const DEP = (await api('POST', `/v1/clients/${cl.id}/deposit-address`, {})).body.address;
const dtx = await funder.writeContract({ address: TOKEN, abi: erc20Abi, functionName: 'transfer', args: [DEP, 700_000_000n] });
await wait(dtx);
await api('POST', '/v1/deposits/report', { tx_hash: dtx });
await mine(confs + 1);
for (let i = 0; i < 4; i++) { await tick(); await mine(confs + 1); }
// Según el saldo nativo de la dirección de depósito será un gas_topup o el sweep_token: cualquiera necesita registrar gas
const sw = (await api('GET', '/v1/sweeps?limit=50')).body.sweeps.find((s) => s.status === 'broadcast' && s.last_error?.startsWith('Custodia nativa insuficiente'));
check('barrido enviado pero sin liquidar por falta de custodia nativa', `${sw?.status} ${sw?.last_error?.includes('Registrar fondeo de gas')}`, 'broadcast true');
let row = await netRow();
check('tablero: barridos detenidos por gas sin registrar', row.gas.stuck_sweeps >= 1, true);
check('tablero: gas sin registrar > 0 (hot wallet en cadena > custodia del libro)', BigInt(row.gas.unregistered_wei) > 0n, true);

// ═════ 2. Validaciones del registro
const hF = await funder.sendTransaction({ to: HOT, value: parseEther('1.25') });
await wait(hF);
const post = (who, body) => (who === 'api' ? api('POST', '/v1/gas-fundings', body) : who === 'ej' ? ej('POST', '/v1/gas-fundings', body) : T1.call('POST', '/v1/gas-fundings', body));
if (confs > 1) check('sin confirmaciones suficientes → 422 not_confirmed', (await post('t', { network: NETWORK, tx_hash: hF, code: await T1.code() })).body?.code, 'not_confirmed');
await mine(confs + 1);
check('con API_KEY global → 403 session_required', (await post('api', { network: NETWORK, tx_hash: hF })).body?.code, 'session_required');
check('ejecutivo → 403', (await post('ej', { network: NETWORK, tx_hash: hF, code: '000000' })).status, 403);
check('sin código 2FA → 422 bad_code', (await post('t', { network: NETWORK, tx_hash: hF })).body?.code, 'bad_code');
check('hash mal formado → 400', (await post('t', { network: NETWORK, tx_hash: '0x1234', code: await T1.code() })).status, 400);
check('red no encendida → 422 network_not_supported', (await post('t', { network: 'polygon-amoy', tx_hash: hF, code: await T1.code() })).body?.code, 'network_not_supported');
const hOther = await funder.sendTransaction({ to: DEP, value: parseEther('0.01') });
await wait(hOther); await mine(confs + 1);
check('destino distinto de la hot wallet → 422 not_to_hot_wallet', (await post('t', { network: NETWORK, tx_hash: hOther, code: await T1.code() })).body?.code, 'not_to_hot_wallet');
const hSelf = await hotW.sendTransaction({ to: HOT, value: 1n });
await wait(hSelf); await mine(confs + 1);
check('origen de la plataforma (la propia hot wallet) → 422 internal_transfer', (await post('t', { network: NETWORK, tx_hash: hSelf, code: await T1.code() })).body?.code, 'internal_transfer');
const hTok = await funder.writeContract({ address: TOKEN, abi: erc20Abi, functionName: 'transfer', args: [HOT, 1n] });
await wait(hTok); await mine(confs + 1);
check('transacción sin moneda nativa → 422', (await post('t', { network: NETWORK, tx_hash: hTok, code: await T1.code() })).body?.code, 'not_to_hot_wallet');
check('hash inexistente → 404', (await post('t', { network: NETWORK, tx_hash: `0x${'ab'.repeat(32)}`, code: await T1.code() })).body?.code, 'tx_not_found');

// ═════ 3. Registro válido, monto de la cadena, idempotente
const reg = await post('t', { network: NETWORK, tx_hash: hF, code: await T1.code() });
check('tesorero con 2FA registra → 201 con el monto de la cadena', `${reg.status} ${reg.body.amount} ${reg.body.asset_id} ${reg.body.network}`, `201 ${parseEther('1.25')} ETH-SEPOLIA ${NETWORK}`);
check('  …custodia del libro = monto registrado', await custody(), parseEther('1.25').toString());
check('  …mismo hash otra vez → 409 already_registered', (await post('t', { network: NETWORK, tx_hash: hF, code: await T1.code() })).body?.code, 'already_registered');
check('  …mismo hash con mayúsculas → 409', (await post('t', { network: NETWORK, tx_hash: hF.toUpperCase().replace('0X', '0x'), code: await T1.code() })).body?.code, 'already_registered');
const e = (await api('GET', `/v1/entries/${reg.body.id}`)).body;
check('  …asiento: cargo custodia / abono patrimonio, clase gas_funding', `${e.kind} ${e.postings.map((p) => `${p.account_code.split(':')[2]}:${p.direction}`).sort().join(',')}`, 'gas_funding custody:debit,equity:credit');
check('  …con quién lo registró y el origen', `${e.metadata.registered_by === T1.email} ${e.metadata.from === privateKeyToAccount(FUNDER_PK).address.toLowerCase()}`, 'true true');
const list = (await T1.call('GET', `/v1/gas-fundings?network=${NETWORK}`)).body.items;
check('lista de fondeos registrados', list.some((g) => g.tx_hash === hF.toLowerCase() && g.amount === parseEther('1.25').toString()), true);
check('  …consulta con API_KEY', (await api('GET', '/v1/gas-fundings')).status, 200);

// ═════ 4. El barrido detenido se liquida solo
for (let i = 0; i < 3; i++) { await tick(); await mine(confs + 1); }
const sw2 = (await api('GET', '/v1/sweeps?limit=50')).body.sweeps.find((s) => s.id === sw.id);
check('el barrido detenido se liquida en el siguiente ciclo', `${sw2.status} ${sw2.last_error}`, 'confirmed null');
row = await netRow();
check('tablero: sin barridos detenidos', row.gas.stuck_sweeps, 0);

// ═════ 5. Un barrido nativo (dirección de depósito → hot wallet) es movimiento interno, no fondeo
const sn = (await api('GET', '/v1/sweeps?limit=100&kind=sweep_native&status=confirmed')).body.sweeps[0];
if (sn) check('barrido nativo de una dirección de depósito → 422 internal_transfer', (await post('t', { network: NETWORK, tx_hash: sn.tx_hash, code: await T1.code() })).body?.code, 'internal_transfer');

console.log(`\n${ok} ok, ${fail} fallos`);
process.exit(fail ? 1 : 0);
