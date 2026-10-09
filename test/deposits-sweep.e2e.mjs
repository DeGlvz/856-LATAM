// E2E: direcciones de depósito HD, registro en webhook (Alchemy Notify simulado) y barrido a la hot wallet.
// Uso: BASE KEY RPC_URL TOKEN FUNDER_PK SIGNER_PK NOTIFY_LOG=<archivo donde el mock escribe> node test/deposits-sweep.e2e.mjs
import fs from 'node:fs';
import { createPublicClient, createWalletClient, http, erc20Abi, parseEther, keccak256, concat, toHex, hexToBytes } from 'viem';
import { privateKeyToAccount, generatePrivateKey, HDKey, hdKeyToAccount } from 'viem/accounts';
import { hardhat } from 'viem/chains';

const { BASE, KEY, RPC_URL, TOKEN, FUNDER_PK, SIGNER_PK, NOTIFY_LOG } = process.env;
const pub = createPublicClient({ chain: hardhat, transport: http(RPC_URL) });
const funder = createWalletClient({ account: privateKeyToAccount(FUNDER_PK), chain: hardhat, transport: http(RPC_URL) });
const R = Math.random().toString(36).slice(2, 10);
let ok = 0, fail = 0;
const check = (n, got, want) => { if (String(got) === String(want)) { ok++; console.log('✔', n); } else { fail++; console.log(`✘ ${n} — esperado ${want}, obtenido ${got}`); } };
const api = async (method, path, body, idem) => {
  const r = await fetch(BASE + path, { method, headers: { 'x-api-key': KEY, 'content-type': 'application/json', ...(idem ? { 'idempotency-key': `${idem}-${R}` } : {}) }, body: body && JSON.stringify(body) });
  return { status: r.status, body: await r.json() };
};
const mine = async (n) => { for (let i = 0; i < n; i++) await pub.request({ method: 'evm_mine', params: [] }); };
const tick = () => api('POST', '/v1/worker/tick');
const bal = async (ref) => (await api('GET', `/v1/accounts/${ref}`)).body.balance;
const tbal = (a) => pub.readContract({ address: TOKEN, abi: erc20Abi, functionName: 'balanceOf', args: [a] });
const U = (n) => (BigInt(n) * 10n ** 6n).toString();
const wait = (h) => pub.waitForTransactionReceipt({ hash: h });

// Preparación: activo, fondeo de gas de la hot wallet registrado en libro
let TUSD = `TUSD-${R.toUpperCase().slice(0, 6)}`;
const ra = await api('POST', '/v1/assets', { id: TUSD, symbol: 'TUSD', chain: 'ethereum', network: 'eth-sepolia', kind: 'erc20', contract_address: TOKEN, decimals: 6 });
if (ra.status === 409) TUSD = (await api('GET', '/v1/assets')).body.assets.find((a) => a.contract_address === TOKEN.toLowerCase()).id;
const hw0 = (await api('GET', '/v1/treasury/hot-wallet')).body;
const HOT = hw0.address;
const hot0 = await tbal(HOT);
// Diferencias de partida (otras pruebas pueden haber dejado fondos fuera de wallets de la plataforma)
const d0 = Object.fromEntries(hw0.balances.map((b) => [b.asset_id, BigInt(b.difference ?? 0)]));
const gap = BigInt(hw0.balances.find((b) => b.asset_id === 'ETH-SEPOLIA').difference);
if (gap > 0n) await api('POST', '/v1/entries', { kind: 'adjustment', postings: [
  { account: 'system:ETH-SEPOLIA:custody', direction: 'debit', amount: gap.toString() },
  { account: 'system:ETH-SEPOLIA:equity', direction: 'credit', amount: gap.toString() }] }, 'gas');
const cl = (await api('POST', '/v1/clients', { name: 'Fondo Y', assets: [TUSD, 'ETH-SEPOLIA'] }, 'cy')).body;
const ACC = `client:${cl.id}:${TUSD}:available`;

// 1. Dirección de depósito derivada y registrada en el webhook
let r = await api('POST', `/v1/clients/${cl.id}/deposit-address`, {});
const DEP = r.body.address;
check('dirección de depósito creada', r.status, 201);
check('  …registrada en webhook', r.body.webhook_registered, true);
const seed = keccak256(concat([toHex('856-latam/deposit-hd/v1'), SIGNER_PK]));
const expected = hdKeyToAccount(HDKey.fromMasterSeed(hexToBytes(seed)), { addressIndex: r.body.derivation_index }).address.toLowerCase();
check('  …derivación HD determinista', DEP, expected);
const notify = fs.readFileSync(NOTIFY_LOG, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
const last = notify.at(-1);
check('  …Notify API: token, webhook y dirección', `${last.token}|${last.body.webhook_id}|${last.body.addresses_to_add.includes(DEP)}`, 'tok_test|wh_test|true');
check('misma dirección en segunda llamada', (await api('POST', `/v1/clients/${cl.id}/deposit-address`, {})).body.address, DEP);
const rot = (await api('POST', `/v1/clients/${cl.id}/deposit-address`, { rotate: true })).body;
check('rotación genera otra dirección', rot.address !== DEP && rot.derivation_index > r.body.derivation_index, true);

// 2. Depósito ERC-20 → acreditado → barrido (gas_topup + sweep_token)
await wait(await funder.writeContract({ address: TOKEN, abi: erc20Abi, functionName: 'transfer', args: [DEP, BigInt(U(1000))] }));
const dtx = (await pub.getBlock({ includeTransactions: true })).transactions.at(-1).hash;
await api('POST', '/v1/deposits/report', { tx_hash: dtx });
await mine(2);
await tick();
check('depósito ERC-20 acreditado: 1000', await bal(ACC), U(1000));
let sw = (await api('GET', '/v1/sweeps')).body.sweeps;
check('sin ETH en la dirección → primero gas_topup', sw[0]?.kind, 'gas_topup');
const topupHash = sw[0].tx_hash;
await mine(1);
check('el gas enviado por la plataforma NO cuenta como depósito', (await api('POST', '/v1/deposits/report', { tx_hash: topupHash })).body.deposits.length, 0);
await mine(2); await tick();
sw = (await api('GET', '/v1/sweeps')).body.sweeps;
check('gas_topup confirmado y sweep_token enviado', `${sw.find((s) => s.kind === 'gas_topup').status}|${sw[0].kind}|${sw[0].status}`, 'confirmed|sweep_token|broadcast');
await mine(3); await tick();
check('sweep_token confirmado', (await api('GET', '/v1/sweeps')).body.sweeps.find((s) => s.kind === 'sweep_token').status, 'confirmed');
check('tokens llegaron a la hot wallet: +1000', (await tbal(HOT)) - hot0, U(1000));
check('dirección de depósito vacía de tokens', await tbal(DEP), 0);
check('saldo del cliente intacto: 1000', await bal(ACC), U(1000));

// 3. Depósito nativo → acreditado → sweep_native
await wait(await funder.sendTransaction({ to: DEP, value: parseEther('0.5') }));
const etx = (await pub.getBlock({ includeTransactions: true })).transactions.at(-1).hash;
await api('POST', '/v1/deposits/report', { tx_hash: etx }); await mine(2); await tick();
check('depósito ETH acreditado: 0.5', await bal(`client:${cl.id}:ETH-SEPOLIA:available`), parseEther('0.5'));
sw = (await api('GET', '/v1/sweeps')).body.sweeps;
check('sweep_native enviado', `${sw[0].kind}|${sw[0].status}`, 'sweep_native|broadcast');
await mine(3); await tick();
check('sweep_native confirmado', (await api('GET', '/v1/sweeps')).body.sweeps[0].status, 'confirmed');
check('en la dirección solo queda polvo (< 0.001 ETH)', (await pub.getBalance({ address: DEP })) < parseEther('0.001'), true);

// 4. Conciliación: on-chain (hot + depósitos) = custodia en libro
const hw = (await api('GET', '/v1/treasury/hot-wallet')).body;
check('conciliación TUSD: sin diferencia nueva', BigInt(hw.balances.find((b) => b.asset_id === TUSD).difference) - (d0[TUSD] ?? 0n), 0);
check('conciliación ETH: sin diferencia nueva (gas registrado)', BigInt(hw.balances.find((b) => b.asset_id === 'ETH-SEPOLIA').difference) - (d0['ETH-SEPOLIA'] - (gap > 0n ? gap : 0n)), 0);

// 5. Con lo barrido, la hot wallet ya puede pagar un retiro
const DEST = privateKeyToAccount(generatePrivateKey()).address;
await api('POST', '/v1/wallets', { client_id: cl.id, chain: 'ethereum', network: 'eth-sepolia', address: DEST, purpose: 'withdrawal_whitelist' });
r = await api('POST', '/v1/withdrawals', { client_id: cl.id, asset_id: TUSD, to_address: DEST, amount: U(600) }, 'w');
await tick(); await mine(3); await tick();
check('retiro de 600 pagado con fondos barridos', (await api('GET', `/v1/withdrawals/${r.body.id}`)).body.status, 'confirmed');
check('  …conciliación sin diferencia nueva', BigInt((await api('GET', '/v1/treasury/hot-wallet')).body.balances.find((b) => b.asset_id === TUSD).difference) - (d0[TUSD] ?? 0n), 0);
console.log(`── ${ok} OK, ${fail} fallas`); process.exit(fail ? 1 : 0);
