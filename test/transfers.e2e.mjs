// Prueba end-to-end de depósitos y retiros on-chain contra una cadena LOCAL (Hardhat/Anvil).
// Uso: BASE=http://localhost:8090 KEY=… RPC_URL=http://127.0.0.1:8545 TOKEN=0x… FUNDER_PK=0x… node test/transfers.e2e.mjs
// El servidor debe correr con RPC_URL a la misma cadena, SIGNER_PRIVATE_KEY de prueba, CONFIRMATIONS=3 y WORKER_ENABLED=false.
import { createPublicClient, createWalletClient, http, erc20Abi, parseEther } from 'viem';
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';
import { hardhat } from 'viem/chains';

const { BASE, KEY, RPC_URL, TOKEN, FUNDER_PK } = process.env;
const pub = createPublicClient({ chain: hardhat, transport: http(RPC_URL) });
const funder = createWalletClient({ account: privateKeyToAccount(FUNDER_PK), chain: hardhat, transport: http(RPC_URL) });
const R = Math.random().toString(36).slice(2, 10);
let ok = 0, fail = 0;
const check = (name, got, want) => { if (String(got) === String(want)) { ok++; console.log('✔', name); } else { fail++; console.log(`✘ ${name} — esperado ${want}, obtenido ${got}`); } };
const api = async (method, path, body, idem) => {
  const r = await fetch(BASE + path, { method, headers: { 'x-api-key': KEY, 'content-type': 'application/json', ...(idem ? { 'idempotency-key': `${idem}-${R}` } : {}) }, body: body && JSON.stringify(body) });
  return { status: r.status, body: await r.json() };
};
const mine = async (n) => { for (let i = 0; i < n; i++) await pub.request({ method: 'evm_mine', params: [] }); };
const tick = () => api('POST', '/v1/worker/tick');
const bal = async (ref) => (await api('GET', `/v1/accounts/${ref}`)).body.balance;
const U = (n) => (BigInt(n) * 10n ** 6n).toString(); // TUSD 6 decimales

// 0. Activo de prueba y tesorería
let TUSD = `TUSD-${R.toUpperCase().slice(0, 6)}`;
const ra = await api('POST', '/v1/assets', { id: TUSD, symbol: 'TUSD', chain: 'ethereum', network: 'eth-sepolia', kind: 'erc20', contract_address: TOKEN, decimals: 6 });
if (ra.status === 409) TUSD = (await api('GET', '/v1/assets')).body.assets.find((a) => a.contract_address === TOKEN.toLowerCase()).id; // corrida previa
check('alta de activo TUSD (o ya existente → 409 limpio)', [201, 409].includes(ra.status), true);
const hw = (await api('GET', '/v1/treasury/hot-wallet')).body;
check('hot wallet configurada', hw.configured, true);
const HOT = hw.address;
// Registrar el ETH que ya tiene la hot wallet (para pagar gas) contra patrimonio
const ethOnchain = hw.balances.find((b) => b.asset_id === 'ETH-SEPOLIA');
const gap = BigInt(ethOnchain.difference);
if (gap > 0n) await api('POST', '/v1/entries', { kind: 'adjustment', description: 'Fondeo gas hot wallet', postings: [
  { account: 'system:ETH-SEPOLIA:custody', direction: 'debit', amount: gap.toString() },
  { account: 'system:ETH-SEPOLIA:equity', direction: 'credit', amount: gap.toString() }] }, 'gas');

// 1. Cliente, wallet de depósito y lista blanca
const cl = (await api('POST', '/v1/clients', { name: 'Tesorería X', assets: [TUSD, 'ETH-SEPOLIA'] }, 'cx')).body;
const ACC = cl.accounts.find((a) => a.asset_id === TUSD).id;
const DEP = privateKeyToAccount(generatePrivateKey()).address;
const DEST = privateKeyToAccount(generatePrivateKey()).address;
check('wallet de depósito', (await api('POST', '/v1/wallets', { client_id: cl.id, chain: 'ethereum', network: 'eth-sepolia', address: DEP, purpose: 'deposit' })).status, 201);
check('dirección en lista blanca', (await api('POST', '/v1/wallets', { client_id: cl.id, chain: 'ethereum', network: 'eth-sepolia', address: DEST, purpose: 'withdrawal_whitelist' })).status, 201);

// 2. Depósito ERC-20: se detecta, espera confirmaciones y se acredita una sola vez
const h1 = await funder.writeContract({ address: TOKEN, abi: erc20Abi, functionName: 'transfer', args: [DEP, BigInt(U(1000))] });
await pub.waitForTransactionReceipt({ hash: h1 });
let r = await api('POST', '/v1/deposits/report', { tx_hash: h1 });
check('depósito detectado', `${r.status}:${r.body.deposits.length}:${r.body.deposits[0]?.status}`, '202:1:pending');
check('reporte repetido no duplica', (await api('POST', '/v1/deposits/report', { tx_hash: h1 })).body.deposits.length, 1);
await tick(); check('antes de 3 confirmaciones: saldo 0', await bal(ACC), 0);
await mine(2); await tick();
check('acreditado tras 3 confirmaciones: 1000', await bal(ACC), U(1000));
await tick(); check('no se acredita dos veces', await bal(ACC), U(1000));

// 3. Depósito nativo (ETH)
const h2 = await funder.sendTransaction({ to: DEP, value: parseEther('2') });
await pub.waitForTransactionReceipt({ hash: h2 });
await api('POST', '/v1/deposits/report', { tx_hash: h2 }); await mine(3); await tick();
check('depósito ETH acreditado', await bal(`client:${cl.id}:ETH-SEPOLIA:available`), parseEther('2').toString());

// 4. Controles de retiro
check('retiro fuera de lista blanca → 422', (await api('POST', '/v1/withdrawals', { client_id: cl.id, asset_id: TUSD, to_address: DEP, amount: U(1) }, 'wl')).body.code, 'address_not_whitelisted');
check('retiro sin saldo → 422', (await api('POST', '/v1/withdrawals', { client_id: cl.id, asset_id: TUSD, to_address: DEST, amount: U(5000) }, 'nf')).body.code, 'insufficient_funds');
const c1 = (await api('POST', '/v1/withdrawals', { client_id: cl.id, asset_id: TUSD, to_address: DEST, amount: U(50) }, 'c1')).body;
check('cancelar retiro reservado', (await api('POST', `/v1/withdrawals/${c1.id}/cancel`)).body.status, 'cancelled');
check('  …saldo devuelto: 1000', await bal(ACC), U(1000));

// 5. Retiro ERC-20 completo: reserva → firma → envío → confirmaciones → liquidación
// (la hot wallet necesita TUSD on-chain: se simula el barrido desde la wallet de depósito)
await pub.waitForTransactionReceipt({ hash: await funder.writeContract({ address: TOKEN, abi: erc20Abi, functionName: 'transfer', args: [HOT, BigInt(U(1000))] }) });
r = await api('POST', '/v1/withdrawals', { client_id: cl.id, asset_id: TUSD, to_address: DEST, amount: U(300) }, 'w1');
const W1 = r.body.id;
check('retiro aceptado (202, reserved)', `${r.status}:${r.body.status}`, '202:reserved');
check('reintento con misma llave → mismo retiro', (await api('POST', '/v1/withdrawals', { client_id: cl.id, asset_id: TUSD, to_address: DEST, amount: U(300) }, 'w1')).body.id, W1);
check('saldo disponible reservado: 700', await bal(ACC), U(700));
check('en tránsito: 300', await bal(`system:${TUSD}:withdrawals_pending`), U(300));
await tick();
let w = (await api('GET', `/v1/withdrawals/${W1}`)).body;
check('firmado y enviado', w.status, 'broadcast');
check('  …tx en cadena', (await pub.getTransactionReceipt({ hash: w.tx_hash })).status, 'success');
check('destino recibió 300 on-chain', await pub.readContract({ address: TOKEN, abi: erc20Abi, functionName: 'balanceOf', args: [DEST] }), U(300));
await tick(); check('aún sin confirmar (1 conf)', (await api('GET', `/v1/withdrawals/${W1}`)).body.status, 'broadcast');
await mine(2); await tick();
w = (await api('GET', `/v1/withdrawals/${W1}`)).body;
check('confirmado tras 3 confirmaciones', w.status, 'confirmed');
check('en tránsito vuelve a 0', await bal(`system:${TUSD}:withdrawals_pending`), 0);
check('gas registrado como gasto', BigInt(w.gas_cost_wei) > 0n && (await bal('system:ETH-SEPOLIA:network_fees')) !== '0', true);

// 6. Retiro nativo ETH
r = await api('POST', '/v1/withdrawals', { client_id: cl.id, asset_id: 'ETH-SEPOLIA', to_address: DEST, amount: parseEther('0.5').toString() }, 'w2');
await tick(); await mine(3); await tick();
check('retiro ETH confirmado', (await api('GET', `/v1/withdrawals/${r.body.id}`)).body.status, 'confirmed');
check('destino recibió 0.5 ETH', await pub.getBalance({ address: DEST }), parseEther('0.5'));

// 7. Fallo de firma: la hot wallet no tiene tokens suficientes → 5 intentos → fallido y saldo devuelto
const h3 = await funder.writeContract({ address: TOKEN, abi: erc20Abi, functionName: 'transfer', args: [DEP, BigInt(U(2000))] });
await pub.waitForTransactionReceipt({ hash: h3 }); await api('POST', '/v1/deposits/report', { tx_hash: h3 }); await mine(3); await tick();
const before = await bal(ACC);
r = await api('POST', '/v1/withdrawals', { client_id: cl.id, asset_id: TUSD, to_address: DEST, amount: U(2500) }, 'w3');
for (let i = 0; i < 5; i++) await tick();
w = (await api('GET', `/v1/withdrawals/${r.body.id}`)).body;
check('sin liquidez on-chain → failed tras 5 intentos', `${w.status}:${w.attempts}`, 'failed:5');
check('  …saldo del cliente intacto', await bal(ACC), before);

// 8. Invariante: el libro sigue cuadrando
const hw2 = (await api('GET', '/v1/treasury/hot-wallet')).body;
check('conciliación hot wallet disponible', Array.isArray(hw2.balances), true);
console.log(`── ${ok} OK, ${fail} fallas`); process.exit(fail ? 1 : 0);
