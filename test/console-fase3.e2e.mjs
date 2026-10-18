// E2E fase 3: retiros, depósitos y barridos desde la consola, contra cadena LOCAL (Hardhat/Anvil).
// Uso: BASE KEY RPC_URL FUNDER_PK BOOT_EMAIL BOOT_PASS node test/console-fase3.e2e.mjs
// API con COOKIE_SECURE=false, WORKER_ENABLED=false, SWEEP_ENABLED=true, CONFIRMATIONS=1, firmante de prueba.
import { execFileSync } from 'node:child_process';
import { createPublicClient, createWalletClient, http, parseEther } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { hardhat } from 'viem/chains';

const { BASE, KEY, RPC_URL, FUNDER_PK, BOOT_EMAIL, BOOT_PASS } = process.env;
const pub = createPublicClient({ chain: hardhat, transport: http(RPC_URL) });
const funder = createWalletClient({ account: privateKeyToAccount(FUNDER_PK), chain: hardhat, transport: http(RPC_URL) });
const R = Math.random().toString(36).slice(2, 8);
const NET = `10.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`;
let ok = 0, fail = 0;
const check = (n, got, want) => { if (String(got) === String(want)) { ok++; console.log('✔', n); } else { fail++; console.log(`✘ ${n} — esperado ${want}, obtenido ${got}`); } };
const mine = async (n) => { for (let i = 0; i < n; i++) await pub.request({ method: 'evm_mine', params: [] }); };

function browser(ip) {
  let cookie = null;
  const call = async (method, path, body, extra = {}) => {
    const r = await fetch(BASE + path, { method, headers: { 'x-forwarded-for': ip, ...(body ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}), ...(method !== 'GET' ? { 'x-856-console': '1' } : {}), ...extra }, body: body && JSON.stringify(body) });
    const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
    return { status: r.status, body: await r.json().catch(() => null) };
  };
  return { call, login: (e, p) => call('POST', '/v1/auth/login', { email: e, password: p }) };
}
const createOperator = (email, role, pw) => execFileSync('node', ['dist/scripts/create-operator.js', email, role], { input: pw + '\n', env: process.env, stdio: ['pipe', 'pipe', 'ignore'] });

const tes = browser(`${NET}.1`); check('login tesorero', (await tes.login(BOOT_EMAIL, BOOT_PASS)).status, 200);
createOperator(`op3-${R}@ejemplo.mx`, 'ejecutivo', 'clave-operador-123');
createOperator(`lec3-${R}@ejemplo.mx`, 'lectura', 'clave-lectura-123');
const opr = browser(`${NET}.2`); await opr.login(`op3-${R}@ejemplo.mx`, 'clave-operador-123');
const lec = browser(`${NET}.3`); await lec.login(`lec3-${R}@ejemplo.mx`, 'clave-lectura-123');
const tick = () => tes.call('POST', '/v1/worker/tick', {});

// Cuadrar gas de la hot wallet en el libro (fondos previos en la cadena local)
const hw = (await tes.call('GET', '/v1/treasury/hot-wallet')).body;
const gap = BigInt(hw.balances.find((b) => b.asset_id === 'ETH-SEPOLIA').difference);
if (gap > 0n) await tes.call('POST', '/v1/entries', { kind: 'adjustment', postings: [
  { account: 'system:ETH-SEPOLIA:custody', direction: 'debit', amount: gap.toString() },
  { account: 'system:ETH-SEPOLIA:equity', direction: 'credit', amount: gap.toString() }] }, { 'idempotency-key': `gap-${R}` });

// ── Cliente activo con dirección de depósito y lista blanca
const cl = (await opr.call('POST', '/v1/clients', { name: `Fondo F3 ${R}`, assets: ['ETH-SEPOLIA'] }, { 'idempotency-key': `c-${R}` })).body;
await opr.call('PATCH', `/v1/clients/${cl.id}`, { status: 'active' });
const dep = (await opr.call('POST', `/v1/clients/${cl.id}/deposit-address`, {})).body;
const DEST = privateKeyToAccount(generatePrivateKey()).address;
await tes.call('POST', '/v1/wallets', { client_id: cl.id, chain: 'ethereum', network: 'eth-sepolia', address: DEST, purpose: 'withdrawal_whitelist' });

// ── Depósito on-chain reportado por el operador
const h = await funder.sendTransaction({ to: dep.address, value: parseEther('0.3') });
await pub.waitForTransactionReceipt({ hash: h });
const rep = await opr.call('POST', '/v1/deposits/report', { tx_hash: h });
check('operador reporta depósito → 202', rep.status, 202);
check('depósito detectado pendiente', rep.body.deposits[0]?.status, 'pending');
await mine(2); await tick();
let deps = (await lec.call('GET', `/v1/deposits?client_id=${cl.id}`)).body;
check('depósito acreditado', deps.deposits[0]?.status, 'credited');
check('depósito trae nombre de cliente', deps.deposits[0]?.client_name, `Fondo F3 ${R}`);
check('depósito trae dirección destino', deps.deposits[0]?.to_address, dep.address);
check('lista de depósitos con next_cursor', 'next_cursor' in deps, true);
check('saldo del cliente = 0.3 ETH', (await lec.call('GET', `/v1/accounts/client:${cl.id}:ETH-SEPOLIA:available`)).body.balance, parseEther('0.3').toString());

// ── Barrido de la dirección de depósito a la hot wallet
for (let i = 0; i < 3; i++) { await tick(); await mine(2); }
await tick();
const sw = (await lec.call('GET', '/v1/sweeps?limit=5')).body;
const mySweep = sw.sweeps.find((s) => s.client_id === cl.id);
check('barrido nativo registrado', mySweep?.kind, 'sweep_native');
check('barrido confirmado', mySweep?.status, 'confirmed');
check('barrido trae nombre de cliente', mySweep?.client_name, `Fondo F3 ${R}`);
check('filtro de barridos por tipo', (await lec.call('GET', '/v1/sweeps?kind=gas_topup')).body.sweeps.every((s) => s.kind === 'gas_topup'), true);

// ── Retiro: cancelación con motivo
const w1 = await tes.call('POST', '/v1/withdrawals', { client_id: cl.id, asset_id: 'ETH-SEPOLIA', to_address: DEST, amount: parseEther('0.05').toString() }, { 'idempotency-key': `w1-${R}` });
check('tesorero solicita retiro → 202', w1.status, 202);
const cx = await opr.call('POST', `/v1/withdrawals/${w1.body.id}/cancel`, { reason: 'Error de captura' });
check('cancelado', cx.body.status, 'cancelled');
const rev = (await lec.call('GET', `/v1/entries/${cx.body.reversal_entry_id}`)).body;
check('reverso registra quién y por qué', rev.description.includes(BOOT_EMAIL) && rev.description.includes('Error de captura'), true);
check('saldo restituido', (await lec.call('GET', `/v1/accounts/client:${cl.id}:ETH-SEPOLIA:available`)).body.balance, parseEther('0.3').toString());

// ── Retiro completo: firma, envío y confirmación
const w2 = (await tes.call('POST', '/v1/withdrawals', { client_id: cl.id, asset_id: 'ETH-SEPOLIA', to_address: DEST, amount: parseEther('0.1').toString() }, { 'idempotency-key': `w2-${R}` })).body;
check('instrucción desde consola queda lista para ejecución directa', w2.approval_status, 'not_required');
await tick(); await mine(2); await tick();
const d2 = (await lec.call('GET', `/v1/withdrawals/${w2.id}`)).body;
check('retiro confirmado', d2.status, 'confirmed');
check('detalle trae nombre de cliente', d2.client_name, `Fondo F3 ${R}`);
check('detalle trae gas pagado', BigInt(d2.gas_cost_wei ?? 0) > 0n, true);
check('destino recibió 0.1 ETH', await pub.getBalance({ address: DEST }), parseEther('0.1').toString());

// ── Listas: filtros, paginación, validación
const l1 = (await lec.call('GET', `/v1/withdrawals?client_id=${cl.id}&limit=1`)).body;
const l2 = (await lec.call('GET', `/v1/withdrawals?client_id=${cl.id}&limit=1&cursor=${l1.next_cursor}`)).body;
check('retiros paginados (2 páginas distintas)', l1.withdrawals[0].id !== l2.withdrawals[0].id && l2.next_cursor === null, true);
check('filtro por estado', (await lec.call('GET', `/v1/withdrawals?client_id=${cl.id}&status=cancelled`)).body.withdrawals.length, 1);
check('estado inválido → 400', (await lec.call('GET', '/v1/withdrawals?status=raro')).status, 400);
check('cursor inválido → 400', (await lec.call('GET', '/v1/deposits?cursor=xyz')).status, 400);
check('lectura no ejecuta worker → 403', (await lec.call('POST', '/v1/worker/tick', {})).status, 403);
const s = (await lec.call('GET', '/v1/summary')).body;
check('tablero: conciliación ETH en cero', s.reconciliation.balances.find((b) => b.asset_id === 'ETH-SEPOLIA').difference, '0');

console.log(`\n${ok} ok, ${fail} fallos`);
process.exit(fail ? 1 : 0);
