// E2E portal de clientes — fase 2: saldos, movimientos, CSV, estado de cuenta, direcciones de depósito, depósitos, avisos y AISLAMIENTO.
// Uso: BASE KEY DATABASE_URL RPC_URL TOKEN FUNDER_PK node test/portal-fase2.e2e.mjs
//      (API con COOKIE_SECURE=false, TOTP_ENCRYPTION_KEY, SIGNER_PRIVATE_KEY, CONFIRMATIONS=1; cadena local Hardhat)
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import pg from 'pg';
import { createPublicClient, createWalletClient, http, erc20Abi } from 'viem';
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';
import { localChain, workerDriver } from './lib/worker.mjs';
import { totp } from './lib/totp.mjs';

const { BASE, KEY, DATABASE_URL, RPC_URL, FUNDER_PK } = process.env;
const hardhat = await localChain(RPC_URL);
const TOKEN = process.env.TOKEN;
const R = Math.random().toString(36).slice(2, 8);
const NET = `10.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`;
let ok = 0, fail = 0;
const check = (n, got, want) => { if (String(got) === String(want)) { ok++; console.log('✔', n); } else { fail++; console.log(`✘ ${n} — esperado ${want}, obtenido ${got}`); } };
const sha = (s) => createHash('sha256').update(s).digest('hex');
const chain = createPublicClient({ chain: hardhat, transport: http(RPC_URL) });
const funder = createWalletClient({ account: privateKeyToAccount(FUNDER_PK), chain: hardhat, transport: http(RPC_URL) });

// Todo lo que responde el portal queda aquí para revisar fugas (system:, nombres ajenos, textos internos)
const seen = []; // { who, text }
// fetch().text() descarta el BOM: se decodifica a mano para poder verificarlo
const raw = async (r) => new TextDecoder('utf-8', { ignoreBOM: true }).decode(await r.arrayBuffer());
const record = (who, text) => { seen.push({ who, text }); return text; };

function portal(ip, who) {
  let cookie = null;
  const call = async (method, path, body, extra = {}) => {
    const r = await fetch(BASE + '/v1/portal' + path, { method, headers: { 'x-forwarded-for': ip, ...(body ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}), ...(method !== 'GET' ? { 'x-856-portal': '1' } : {}), ...extra }, body: body && JSON.stringify(body) });
    const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
    const text = record(who, await raw(r));
    let json = null; try { json = JSON.parse(text); } catch { /* CSV */ }
    return { status: r.status, body: json, text, type: r.headers.get('content-type'), disp: r.headers.get('content-disposition') };
  };
  const login = async (email, password, otp) => {
    const r = await call('POST', '/auth/login', { email, password });
    if (r.body?.mfa_required && otp) return call('POST', '/auth/login/totp', { mfa_token: r.body.mfa_token, code: await otp.next() });
    return r;
  };
  return { call, login };
}
const api = async (method, path, body, idem) => {
  const r = await fetch(BASE + path, { method, headers: { 'x-api-key': KEY, 'content-type': 'application/json', ...(idem ? { 'idempotency-key': `${idem}-${R}` } : {}) }, body: body && JSON.stringify(body) });
  return { status: r.status, body: await r.json() };
};
async function signed(priv, prefix, method, path, who) {
  const ts = String(Math.floor(Date.now() / 1000));
  const nonce = Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
  const sig = sign(null, Buffer.from(`${method}\n/v1/portal${path}\n${ts}\n${nonce}\n${sha('')}`), priv).toString('base64url');
  const r = await fetch(BASE + '/v1/portal' + path, { method, headers: { 'x-forwarded-for': `${NET}.50`, 'x-856-key': prefix, 'x-856-timestamp': ts, 'x-856-nonce': nonce, 'x-856-signature': sig } });
  const text = record(who, await raw(r));
  return { status: r.status, body: JSON.parse(text) };
}
const bearer = async (t, method, path, who) => {
  const r = await fetch(BASE + '/v1/portal' + path, { method, headers: { authorization: `Bearer ${t}`, 'x-forwarded-for': `${NET}.60`, ...(method !== 'GET' ? { 'content-type': 'application/json' } : {}) }, body: method !== 'GET' ? '{}' : undefined });
  const text = record(who, await raw(r));
  let json = null; try { json = JSON.parse(text); } catch { /* CSV */ }
  return { status: r.status, body: json, text };
};
const tokenOf = (link) => link.split('#')[1];
const PW = 'clave-portal-12345';
const mine = async (n) => { for (let i = 0; i < n; i++) await chain.request({ method: 'evm_mine', params: [] }); };
const worker = workerDriver({ BASE, KEY });
const tick = () => worker.run(A.id);
// Unidades humanas exactas (6 decimales fijos) → base, sin flotantes
const fromHuman = (s, d) => { const [i, f = ''] = s.split('.'); return BigInt(i + f.padEnd(d, '0')); };
const human = (v, d) => { const s = BigInt(v).toString().padStart(d + 1, '0'); return `${s.slice(0, -d)}.${s.slice(-d)}`; };

// ═════ Preparación: activo de prueba (ERC-20 local, 6 decimales), clientes A, B y C
let TUSD = `TUSD${R.toUpperCase().slice(0, 4)}`;
const ra = await api('POST', '/v1/assets', { id: TUSD, symbol: 'TUSD', chain: 'ethereum', network: 'eth-sepolia', kind: 'erc20', contract_address: TOKEN, decimals: 6 });
if (ra.status !== 201) TUSD = (await api('GET', '/v1/assets')).body.assets.find((a) => a.contract_address === TOKEN.toLowerCase()).id;
const USDC = 'USDC-ETH-SEPOLIA';
const NAME_A = `Portal2 Alfa ${R}`, NAME_B = `Portal2 Beta ${R}`, NAME_C = `Tercero Confidencial ${R}`;
const A = (await api('POST', '/v1/clients', { name: NAME_A, assets: [TUSD, USDC] }, 'a')).body;
const B = (await api('POST', '/v1/clients', { name: NAME_B, assets: [USDC] }, 'b')).body;
const C = (await api('POST', '/v1/clients', { name: NAME_C, assets: [USDC] }, 'c')).body;
await api('PATCH', `/v1/clients/${A.id}`, { status: 'active' }); // B queda en KYB (aviso)
await api('PATCH', `/v1/clients/${C.id}`, { status: 'active' });

// Usuarios: admin A (2FA), viewer A, operador A; admin B
const users = {};
async function enroll(clientId, ip, role, inviter) {
  const email = `${role}-${R}-${clientId.slice(0, 4)}@ejemplo.mx`;
  const inv = inviter ? (await inviter.call('POST', '/users/invites', { email, role })).body : (await api('POST', `/v1/clients/${clientId}/portal-invite`, { email })).body;
  await portal(`${NET}.2`, 'pub').call('POST', '/invites/accept', { token: tokenOf(inv.link), name: `Usuario ${role}`, password: PW });
  const s = portal(ip, clientId === A.id ? 'A' : 'B');
  await s.login(email, PW);
  let otp = null;
  if (role === 'admin' || role === 'approver') {
    const st = (await s.call('POST', '/auth/totp/setup', {})).body; otp = totp(st.secret);
    await s.call('POST', '/auth/totp/enable', { code: await otp.next() });
  }
  return { s, email, otp };
}
const admA = await enroll(A.id, `${NET}.3`, 'admin');
const viewA = await enroll(A.id, `${NET}.4`, 'viewer', admA.s);
const opA = await enroll(A.id, `${NET}.5`, 'operator', admA.s);
const admB = await enroll(B.id, `${NET}.6`, 'admin');
const a = admA.s, v = viewA.s, o = opA.s, b = admB.s;
check('usuarios del portal listos (A: admin/viewer/operador, B: admin)', (await a.call('GET', '/users')).body.users.length, 3);

// ═════ Fondeo de A con asientos contra custodia (descripción y referencia internas que NUNCA deben verse)
const SECRET = `NOTA-INTERNA-OPERADOR-${R}`, FOLIO = `FOLIO-INTERNO-${R}`;
const ACC_T = `client:${A.id}:${TUSD}:available`, ACC_U = `client:${A.id}:${USDC}:available`;
const entry = (acc, asset, dir, amount, i, kind = 'adjustment') => api('POST', '/v1/entries', {
  kind, description: `${SECRET} ${i}`, external_ref: FOLIO, metadata: { nota: SECRET, deposit_id: 'no-uuid', withdrawal_id: B.id },
  postings: [
    { account: acc, direction: dir, amount },
    { account: `system:${asset}:custody`, direction: dir === 'credit' ? 'debit' : 'credit', amount },
  ] }, `e${i}`);
const MOVES = [['credit', '1000000001'], ['credit', '250500000'], ['debit', '500001'], ['credit', '1'], ['debit', '2000000'], ['credit', '3333333']];
for (const [i, [dir, amt]] of MOVES.entries()) {
  const r = await entry(ACC_T, TUSD, dir, amt, i, i === 1 ? 'deposit' : 'adjustment');
  if (r.status !== 201) console.log('asiento', r.status, r.body);
}
const BIG = '123456789012345678901234567'; // > 2^53: cualquier float lo arruinaría
await entry(ACC_U, USDC, 'credit', BIG, 'big');

// ═════ Direcciones de depósito (operador+), rotación y depósito real en Hardhat
check('viewer no genera direcciones → 403', (await v.call('POST', '/deposit-addresses', {})).body?.code, 'forbidden');
const d1 = await o.call('POST', '/deposit-addresses', {});
check('operador genera dirección → 201 con uri para QR', `${d1.status} ${/^ethereum:0x[0-9a-fA-F]{40}@\d+$/.test(d1.body.uri) && d1.body.uri.startsWith(`ethereum:${d1.body.address}@`)} ${d1.body.active}`, '201 true true');
check('  …red no soportada → 422', (await o.call('POST', '/deposit-addresses', { network: 'tron-nile' })).body.code, 'network_not_supported');
const d2 = await o.call('POST', '/deposit-addresses', { network: 'eth-sepolia' });
check('rotar = generar otra (índice HD mayor)', d2.body.address !== d1.body.address && d2.body.derivation_index > d1.body.derivation_index, true);
const das = (await v.call('GET', '/deposit-addresses')).body.addresses;
check('viewer lista ambas direcciones, las dos activas', `${das.length} ${das.every((x) => x.active)}`, '2 true');
check('  …campos públicos solamente', Object.keys(das[0]).sort().join(), 'active,address,created_at,derivation_index,explorer,id,network,network_label,uri');

const DEP_AMT = 777123456n;
const h = await funder.writeContract({ address: TOKEN, abi: erc20Abi, functionName: 'transfer', args: [d1.body.address, DEP_AMT] });
await chain.waitForTransactionReceipt({ hash: h });
const rep = await api('POST', '/v1/deposits/report', { tx_hash: h });
check('depósito a la dirección ANTERIOR detectado', rep.body.deposits?.length, 1);
let deps = (await v.call('GET', '/deposits')).body.deposits;
check('depósito visible como pending (antes de acreditar)', `${deps.length} ${deps[0]?.status} ${deps[0]?.tx_hash === h} ${deps[0]?.amount}`, `1 pending true ${DEP_AMT}`);
check('  …filtro status=credited vacío', (await v.call('GET', '/deposits?status=credited')).body.deposits.length, 0);
await mine(3); await tick();
deps = (await v.call('GET', '/deposits')).body.deposits;
check('depósito pending → credited', `${deps[0].status} ${deps[0].confirmations >= 1} ${deps[0].to_address === d1.body.address}`, 'credited true true');
check('  …sin datos internos (wallet_id, entry_id, client_name)', ['wallet_id', 'entry_id', 'client_name', 'client_id'].some((k) => k in deps[0]), false);

// ═════ Retiro reservado de A (lista blanca) y obligaciones abiertas A↔B y con C
const DEST = privateKeyToAccount(generatePrivateKey()).address;
await api('POST', '/v1/wallets', { client_id: A.id, chain: 'ethereum', network: 'eth-sepolia', address: DEST, purpose: 'withdrawal_whitelist' });
const WD = 100000000n;
const wd = (await api('POST', '/v1/withdrawals', { client_id: A.id, asset_id: TUSD, to_address: DEST, amount: WD.toString() }, 'wd')).body;
check('retiro de A reservado', wd.status, 'reserved');
const obl = (d, c, amt, i) => api('POST', '/v1/obligations', { debtor_id: d, creditor_id: c, asset_id: USDC, amount: amt, external_ref: `${FOLIO}-${i}` }, `o${i}`);
await obl(A.id, B.id, '300000000', 1); await obl(B.id, A.id, '50000000', 2);
await obl(C.id, A.id, '70000000', 3); await obl(A.id, C.id, '20000000', 4);

// ═════ 1. Saldos
let availT = 0n; for (const [dir, amt] of MOVES) availT += dir === 'credit' ? BigInt(amt) : -BigInt(amt);
availT += DEP_AMT - WD;
const bal = (await v.call('GET', '/balances')).body;
const bt = bal.balances.find((x) => x.asset_id === TUSD), bu = bal.balances.find((x) => x.asset_id === USDC);
check('saldo TUSD: available exacto', bt.available, availT);
check('  …reserved = retiro en vuelo', bt.reserved, WD);
check('  …total = available + reserved', bt.total, availT + WD);
check('  …metadatos del activo', `${bt.symbol} ${bt.decimals} ${bt.network}`, 'TUSD 6 eth-sepolia');
check('saldo USDC sin pérdida de precisión', bu.available, BIG);
check('  …payable (A deudor, open) = 300 + 20', bu.payable, 320000000);
check('  …receivable (A acreedor, open) = 50 + 70', bu.receivable, 120000000);
check('  …montos como string', [bt.available, bt.reserved, bu.payable].every((x) => typeof x === 'string'), true);

// ═════ 2. Actividad reciente
const act = (await v.call('GET', '/activity')).body.items;
check('actividad: 9 movimientos (≤ 10 por defecto) de ambas cuentas', `${act.length} ${new Set(act.map((x) => x.asset_id)).size}`, '9 2');
check('  …limit=3', (await v.call('GET', '/activity?limit=3')).body.items.length, 3);
check('  …limit > 50 → 400', (await v.call('GET', '/activity?limit=51')).status, 400);

// ═════ 3. Historial paginado de la cuenta TUSD
const all = []; let cur = null, pages = 0;
do {
  const r = (await v.call('GET', `/accounts/${TUSD}/entries?limit=3${cur ? `&cursor=${cur}` : ''}`)).body;
  all.push(...r.entries); cur = r.next_cursor; pages++;
} while (cur && pages < 20);
check('paginación: 8 movimientos en 3 páginas, sin duplicados', `${all.length} ${pages} ${new Set(all.map((x) => x.id)).size}`, '8 3 8');
const net = all.reduce((s, x) => s + (x.direction === 'credit' ? BigInt(x.amount) : -BigInt(x.amount)), 0n);
check('  …abonos − cargos = saldo disponible', net, availT);
check('  …el más reciente trae balance_after = saldo', all[0].balance_after, availT);
const depLine = all.find((x) => x.reference === h);
check('  …depósito on-chain con su tx hash como referencia', `${depLine?.label} ${depLine?.reference_type} ${depLine?.direction}`, 'Depósito on-chain acreditado tx_hash credit');
const wdLine = all.find((x) => x.kind === 'withdrawal');
check('  …retiro con id del retiro como referencia', `${wdLine.reference === wd.id} ${wdLine.reference_type} ${wdLine.amount} ${wdLine.label}`, `true withdrawal ${WD} Retiro (saldo reservado para envío)`);
const manual = all.filter((x) => x.kind === 'adjustment');
check('  …asientos del operador: label genérico, sin referencia interna', `${manual.length} ${manual.every((x) => x.reference === null)} ${manual.some((x) => x.label === 'Ajuste en contra')}`, '5 true true');
check('  …metadata ajena (withdrawal_id de otro) no se usa como referencia', all.every((x) => x.reference !== B.id), true);
check('  …campos del contrato', Object.keys(all[0]).sort().join(), 'amount,asset_id,balance_after,created_at,direction,id,kind,label,reference,reference_type');
check('activo que A no tiene → 404', (await v.call('GET', '/accounts/ETH-SEPOLIA/entries')).status, 404);
check('activo inexistente → 404', (await v.call('GET', '/accounts/NOPE-XX/entries')).status, 404);
check('cursor inválido → 400', (await v.call('GET', `/accounts/${TUSD}/entries?cursor=xyz`)).status, 400);
check('to en el pasado → sin movimientos', (await v.call('GET', `/accounts/${TUSD}/entries?to=2000-01-01`)).body.entries.length, 0);
const monthStart = `${new Date().toISOString().slice(0, 7)}-01T00:00:00Z`;
check('from = inicio del mes → todos', (await v.call('GET', `/accounts/${TUSD}/entries?from=${monthStart}&limit=200`)).body.entries.length, 8);

// ═════ 4. CSV y estado de cuenta
const csv = await v.call('GET', `/accounts/${TUSD}/entries.csv`);
const rows = csv.text.replace(/^﻿/, '').trim().split('\r\n').map((l) => l.split(','));
check('CSV: BOM UTF-8, tipo y descarga', `${csv.text.charCodeAt(0) === 0xfeff} ${csv.type.startsWith('text/csv')} ${csv.disp.includes('attachment')}`, 'true true true');
check('  …encabezados en español', rows[0].join(), 'Fecha (UTC),Concepto,Tipo,Cargo,Abono,Saldo,Referencia,Id de movimiento');
const body = rows.slice(1);
const csvNet = body.reduce((s, r) => s + (r[4] ? fromHuman(r[4], 6) : 0n) - (r[3] ? fromHuman(r[3], 6) : 0n), 0n);
check('  …8 renglones; abonos − cargos (unidades humanas exactas) = saldo', `${body.length} ${csvNet}`, `8 ${availT}`);
check('  …último saldo = saldo actual con 6 decimales', body.at(-1)[5], human(availT, 6));
check('  …monto mínimo exacto (0.000001)', body.some((r) => r[4] === '0.000001'), true);
const csvU = await v.call('GET', `/accounts/${USDC}/entries.csv`);
check('  …monto enorme exacto en CSV', csvU.text.includes('123456789012345678901.234567'), true);

const period = new Date().toISOString().slice(0, 7);
const stmt = (await v.call('GET', `/statements/${period}?asset=${TUSD}`)).body;
const O = BigInt(stmt.opening_balance), Cr = BigInt(stmt.credits), Db = BigInt(stmt.debits), Cl = BigInt(stmt.closing_balance);
check('estado de cuenta: inicial + abonos − cargos = final', O + Cr - Db, Cl);
check('  …final = saldo actual', `${Cl} ${stmt.current_balance}`, `${availT} ${availT}`);
check('  …renglones del periodo cuadran con abonos y cargos', `${stmt.entries.length} ${stmt.entries.filter((x) => x.direction === 'credit').reduce((s, x) => s + BigInt(x.amount), 0n) === Cr} ${stmt.entries.filter((x) => x.direction === 'debit').reduce((s, x) => s + BigInt(x.amount), 0n) === Db}`, '8 true true');
check('  …orden cronológico ascendente', stmt.entries.every((x, i, arr) => i === 0 || new Date(arr[i - 1].created_at) <= new Date(x.created_at)), true);
const [py, pm] = period.split('-').map(Number);
const prev = pm === 1 ? `${py - 1}-12` : `${py}-${String(pm - 1).padStart(2, '0')}`;
const sp = (await v.call('GET', `/statements/${prev}?asset=${TUSD}`)).body;
check('mes anterior: sin movimientos, inicial = final = 0', `${sp.entries.length} ${sp.opening_balance} ${sp.closing_balance}`, '0 0 0');
check('periodo inválido → 400', (await v.call('GET', `/statements/2026-13?asset=${TUSD}`)).status, 400);
check('sin asset → 400', (await v.call('GET', `/statements/${period}`)).status, 400);
const sc = await v.call('GET', `/statements/${period}.csv?asset=${TUSD}`);
const sl = sc.text.replace(/^﻿/, '').split('\r\n');
check('estado de cuenta CSV: BOM y resumen', `${sc.text.charCodeAt(0) === 0xfeff} ${sl[0].startsWith('Estado de cuenta,TUSD')}`, 'true true');
check('  …saldo inicial/final en unidades humanas', `${sl[2]}|${sl[5]}`, `Saldo inicial,${human(O, 6)}|Saldo final,${human(Cl, 6)}`);
check('  …8 renglones de movimientos', sl.slice(8).filter(Boolean).length, 8);

// ═════ 7. Avisos
const kRead = (await a.call('POST', '/keys', { name: 'BI corto', kind: 'read_token', expires_days: 10, code: await admA.otp.next() })).body;
const nv = (await v.call('GET', '/notices')).body.notices.map((n) => n.code);
check('avisos viewer A: 2FA inactivo, <2 admins, llave por vencer; sin KYB', `${nv.includes('totp_disabled')} ${nv.includes('admins_below_minimum')} ${nv.includes('api_key_expiring')} ${nv.includes('kyb_pending')}`, 'true true true false');
const na = (await a.call('GET', '/notices')).body.notices;
check('avisos admin A (con 2FA): sin aviso de 2FA', na.some((n) => n.code === 'totp_disabled'), false);
check('  …llave por vencer con prefijo y días', `${na.find((n) => n.code === 'api_key_expiring')?.data.prefix === kRead.prefix} ${na.find((n) => n.code === 'api_key_expiring')?.data.days_left}`, 'true 10');
const nb = (await b.call('GET', '/notices')).body.notices.map((n) => n.code);
check('avisos B: KYB pendiente; sin la llave de A', `${nb.includes('kyb_pending')} ${nb.includes('api_key_expiring')}`, 'true false');

// ═════ Llaves: token de lectura y firma Ed25519 en los GET; escritura con token rechazada
const viaTok = await bearer(kRead.token, 'GET', '/balances', 'A');
check('token de lectura → /balances igual que la sesión', JSON.stringify(viaTok.body.balances), JSON.stringify(bal.balances));
check('token de lectura → historial y CSV', `${(await bearer(kRead.token, 'GET', `/accounts/${TUSD}/entries?limit=2`, 'A')).body.entries.length} ${(await bearer(kRead.token, 'GET', `/accounts/${TUSD}/entries.csv`, 'A')).text.includes('Fecha (UTC)')}`, '2 true');
check('token de lectura → depósitos, direcciones, avisos, estado de cuenta, actividad',
  [(await bearer(kRead.token, 'GET', '/deposits', 'A')).status, (await bearer(kRead.token, 'GET', '/deposit-addresses', 'A')).status,
    (await bearer(kRead.token, 'GET', '/notices', 'A')).status, (await bearer(kRead.token, 'GET', `/statements/${period}?asset=${TUSD}`, 'A')).status,
    (await bearer(kRead.token, 'GET', '/activity', 'A')).status].join(), '200,200,200,200,200');
check('token de lectura no genera direcciones → 403', (await bearer(kRead.token, 'POST', '/deposit-addresses', 'A')).body.code, 'session_required');
const proof = (priv, c) => sign(null, Buffer.from(`856-latam/key-proof/v1:${c}`), priv).toString('base64url');
async function edKey(perms) {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const ch = (await a.call('POST', '/keys/challenge', {})).body;
  const k = (await a.call('POST', '/keys', { name: `ERP ${perms}`, kind: 'ed25519', permissions: perms, public_key: publicKey.export({ format: 'jwk' }).x, challenge: ch.challenge, proof: proof(privateKey, ch.challenge), code: await admA.otp.next() })).body;
  return { priv: privateKey, prefix: k.prefix };
}
const kEd = await edKey(['read']);
const sEnt = await signed(kEd.priv, kEd.prefix, 'GET', `/accounts/${TUSD}/entries?limit=5`, 'A');
check('firma Ed25519 (con query firmada) → historial de A', `${sEnt.status} ${sEnt.body.entries.length} ${sEnt.body.balance}`, `200 5 ${availT}`);
check('firma Ed25519 → saldos', (await signed(kEd.priv, kEd.prefix, 'GET', '/balances', 'A')).body.balances.length, 2);
const kTrade = await edKey(['trade']);
check('llave sin permiso read → GET 403', (await signed(kTrade.priv, kTrade.prefix, 'GET', '/balances', 'A')).body.code, 'forbidden');

// ═════ AISLAMIENTO: B no ve nada de A
const bb = (await b.call('GET', '/balances?client_id=' + A.id)).body.balances;
check('B: solo su USDC (client_id en query se ignora)', bb.map((x) => x.asset_id).join(), USDC);
check('  …B available 0, payable 50, receivable 300 (solo obligaciones propias)', `${bb[0].available} ${bb[0].payable} ${bb[0].receivable} ${bb[0].reserved}`, '0 50000000 300000000 0');
check('B: historial TUSD (activo de A) → 404', (await b.call('GET', `/accounts/${TUSD}/entries`)).status, 404);
check('B: CSV TUSD → 404', (await b.call('GET', `/accounts/${TUSD}/entries.csv`)).status, 404);
check('B: estado de cuenta TUSD → 404 (JSON y CSV)', `${(await b.call('GET', `/statements/${period}?asset=${TUSD}`)).status} ${(await b.call('GET', `/statements/${period}.csv?asset=${TUSD}`)).status}`, '404 404');
check('B: su USDC sin movimientos', (await b.call('GET', `/accounts/${USDC}/entries`)).body.entries.length, 0);
check('B: cursor de A sobre su cuenta → nada de A', (await b.call('GET', `/accounts/${USDC}/entries?cursor=${encodeURIComponent((await v.call('GET', `/accounts/${TUSD}/entries?limit=1`)).body.next_cursor)}`)).body.entries.length, 0);
check('B: actividad, depósitos y direcciones vacíos', [(await b.call('GET', '/activity')).body.items.length, (await b.call('GET', '/deposits')).body.deposits.length, (await b.call('GET', '/deposit-addresses')).body.addresses.length].join(), '0,0,0');
const bs = await b.call('GET', `/statements/${period}?asset=${USDC}`);
check('B: estado de cuenta USDC propio en ceros', `${bs.status} ${bs.body.closing_balance} ${bs.body.entries.length}`, '200 0 0');
const bTexts = seen.filter((s) => s.who === 'B').map((s) => s.text).join('\n');
check('ninguna respuesta de B contiene el nombre de C', bTexts.includes(NAME_C), false);
check('ninguna respuesta de B contiene nombre, id, hash o retiro de A', [NAME_A, A.id, h, wd.id, d1.body.address].some((x) => bTexts.includes(x)), false);
const allTexts = seen.map((s) => s.text).join('\n');
check('ninguna respuesta del portal contiene "system:"', allTexts.includes('system:'), false);
check('ninguna respuesta contiene descripción, folio ni metadata interna', [SECRET, FOLIO, 'master_hot', 'hot_wallet', 'custody'].some((x) => allTexts.includes(x)), false);
check('ninguna respuesta de A contiene el nombre de C', seen.filter((s) => s.who === 'A').some((s) => s.text.includes(NAME_C)), false);

// ═════ Bitácora con cliente
const db = new pg.Client({ connectionString: DATABASE_URL }); await db.connect();
const { rows: au } = await db.query(`SELECT action, status, actor FROM audit_log WHERE client_id = $1 AND action LIKE 'PORTAL % /v1/portal/deposit-addresses'`, [A.id]);
await db.end();
check('bitácora: alta de dirección (201) y rechazo del viewer (403) con client_id de A', `${au.some((r) => r.status === 201 && r.actor === `portal:${opA.email}`)} ${au.some((r) => r.status === 403 && r.actor === `portal:${viewA.email}`)}`, 'true true');

console.log(`\n${ok} ok, ${fail} fallos`);
process.exit(fail ? 1 : 0);
