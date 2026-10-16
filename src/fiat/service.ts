// Fase F1 — entrada SEPA → EURe en modo tesorería única.
//
//  cliente: aviso de pago (referencia 856-XXXX-XXXX-NNN) → transfiere por SEPA con esa referencia
//  proveedor: registra la orden (received) → acuña EURe en la dirección de tesorería fiat (minted)
//  856: concilia orden + transferencia on-chain confirmada (mismo hash, mismo monto) → reconciled | review
//  tesorero: libera con 2FA (released → asiento custodia / cliente) o rechaza con motivo (rejected)
// Solo «released» mueve saldo disponible. Acreditar es proceso de sistema (compatible con ORIGIN_RULE=enforce).
import { createHash, randomInt } from 'node:crypto';
import { decodeEventLog, erc20Abi, type Address, type Hash } from 'viem';
import { config } from '../config.js';
import { pool, tx, type Tx } from '../db.js';
import { HttpError } from '../idempotency.js';
import { getDepositKeyring } from '../chain/signer.js';
import { findNet, type Net } from '../chain/networks.js';
import { fiatNetworkId } from '../environment.js';
import { registerOnWebhook } from '../ledger/deposit-addresses.js';
import { openClientAccount, postEntryIn } from '../ledger/service.js';
import { decodeCursor, page } from '../pagination.js';
import { tradeOrigin } from '../portal/obligations.js';
import type { PortalPrincipal } from '../portal/identity.js';
import { getFiatProvider, mockProvider, providerCalls, type FiatOrder, type FiatProvider } from './provider.js';

type Log = { info: (o: object, m: string) => void; warn: (o: object, m: string) => void; error: (o: object, m: string) => void };
const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const CENT_TO_TOKEN = 10n ** 16n; // EURe tiene 18 decimales; el EUR, 2
const INTENT_ES: Record<string, string> = { matched: 'ya usado por otro depósito', expired: 'vencido', cancelled: 'cancelado por el cliente' };

// ═════════════ Montos (sin float) ═════════════
/** "1250.5" | "1250.50" | "1250" → céntimos. Más de 2 decimales, signo o formato raro → null. */
export function eurToCents(s: string): bigint | null {
  const m = /^(\d{1,15})(?:\.(\d{1,2}))?$/.exec(String(s).trim());
  if (!m) return null;
  const c = BigInt(m[1]) * 100n + BigInt((m[2] ?? '').padEnd(2, '0') || '0');
  return c > 0n ? c : null;
}
export const centsToEur = (c: bigint | string) => { const v = BigInt(c); return `${v / 100n}.${(v % 100n).toString().padStart(2, '0')}`; };

// ═════════════ Referencias ═════════════
const ALPHA = '23456789ABCDEFGHJKMNPQRSTVWXYZ'; // sin 0/O, 1/I/L, U
const rnd = (n: number) => Array.from({ length: n }, () => ALPHA[randomInt(ALPHA.length)]).join('');
/** Dígitos de control: detectan la mayoría de errores de captura en el banco. */
const check = (body: string) => (parseInt(createHash('sha256').update(body).digest('hex').slice(0, 8), 16) % 1000).toString().padStart(3, '0');
export const newReference = () => { const body = `856-${rnd(4)}-${rnd(4)}`; return `${body}-${check(body)}`; };
const REF_RE = new RegExp(`856-?([${ALPHA}]{4})-?([${ALPHA}]{4})-?(\\d{3})`);
const CODE_RE = new RegExp(`856-?([${ALPHA}]{4})-?([${ALPHA}]{4})(?![-\\d${ALPHA}])`);
/** Busca en el concepto SEPA (los bancos pueden quitar guiones o espacios) la referencia de un aviso o un código de contraparte. */
export function parseMemo(memo: string | null) {
  const s = (memo ?? '').toUpperCase().replace(/\s+/g, '');
  const r = REF_RE.exec(s);
  if (r) {
    const body = `856-${r[1]}-${r[2]}`;
    return { reference: `${body}-${r[3]}`, reference_valid: check(body) === r[3], counterparty_code: null as string | null };
  }
  const c = CODE_RE.exec(s);
  return { reference: null as string | null, reference_valid: false, counterparty_code: c ? `856-${c[1]}-${c[2]}` : null };
}

// ═════════════ Contexto ═════════════
function provider(): FiatProvider {
  const p = getFiatProvider();
  if (!p) throw new HttpError(503, 'Entrada de fiat apagada en este despliegue (FIAT_LIVE_ENABLED=false)', 'fiat_disabled');
  return p;
}
function fiatNet(): Net {
  const n = findNet(fiatNetworkId());
  if (!n) throw new HttpError(503, `La red de fiat ${fiatNetworkId()} no está encendida en este despliegue`, 'fiat_network_off');
  return n;
}
async function fiatAsset(c: Tx | typeof pool = pool) {
  const { rows: [a] } = await c.query(
    `SELECT id, contract_address, decimals FROM assets WHERE network = $1 AND symbol = 'EURe' AND kind = 'erc20' AND active ORDER BY id LIMIT 1`, [fiatNet().id]);
  if (!a) throw new HttpError(503, `No hay activo EURe activo en ${fiatNet().id}`, 'fiat_asset_missing');
  if (Number(a.decimals) !== 18) throw new HttpError(503, 'El activo EURe debe tener 18 decimales', 'fiat_asset_invalid');
  return a as { id: string; contract_address: string; decimals: number };
}
async function currentAccount(c: Tx | typeof pool = pool, lock = false) {
  const p = getFiatProvider();
  if (!p) return null;
  const { rows: [a] } = await c.query(
    `SELECT * FROM fiat_accounts WHERE provider = $1 AND mode = 'treasury' AND status <> 'closed' ${lock ? 'FOR UPDATE' : ''}`, [p.name]);
  return a ?? null;
}
const accountView = (a: Record<string, unknown> | null) => a && {
  id: a.id, provider: a.provider, mode: a.mode, status: a.status, iban: a.iban, bic: a.bic, beneficiary: a.beneficiary,
  network: a.network, address: a.address, provider_state: a.provider_state, created_at: a.created_at, updated_at: a.updated_at,
};

// ═════════════ Consola: estado y alta ═════════════
export async function status() {
  const p = getFiatProvider();
  const acc = await currentAccount();
  const { rows: [s] } = p ? await pool.query('SELECT last_poll_at, last_error FROM fiat_sync_state WHERE provider = $1', [p.name]) : { rows: [] };
  const { rows: [q] } = await pool.query(
    `SELECT count(*) FILTER (WHERE status = 'reconciled')::int AS reconciled, count(*) FILTER (WHERE status = 'review')::int AS review,
            count(*) FILTER (WHERE status IN ('received','minted'))::int AS in_flight FROM fiat_deposits`);
  return {
    enabled: !!p, provider: p?.name ?? null, live: p?.live ?? false, live_switch: config.FIAT_LIVE_ENABLED, mode: config.FIAT_MODE,
    network: fiatNetworkId(), account: accountView(acc), last_poll_at: s?.last_poll_at ?? null, last_error: s?.last_error ?? null,
    provider_calls: providerCalls(), queue: q,
  };
}

/**
 * Alta / avance del alta (idempotente; se puede repetir para refrescar el IBAN):
 *  1. reserva una dirección HD de 856 (índice propio, nunca una wallet personal) en la red de fiat
 *  2. verifica que el EURe que anuncia el proveedor sea el mismo contrato del catálogo
 *  3. liga la dirección al perfil (firma de mensaje de propiedad, sin gas) y pide el IBAN
 *  4. registra la dirección en el webhook Address Activity de Alchemy de esa red (el de M1; no se crea otro)
 */
export async function setup(by: string, log?: Log) {
  const p = provider();
  const n = fiatNet();
  const asset = await fiatAsset();
  const keyring = getDepositKeyring();
  if (!keyring) throw new HttpError(503, 'Falta la semilla HD (HD_MNEMONIC o DEPOSIT_HD_SEED)', 'keyring_missing');

  // 2. contrato anunciado por el proveedor = contrato del catálogo (verificado en el explorador en M1)
  const mock = mockProvider();
  if (mock && !(await mock.tokens()).length) mock.setTokens([{ symbol: 'EURe', chain: mock.chainName(), address: asset.contract_address, decimals: 18 }]);
  const tk = (await p.tokens()).find((t) => t.symbol === 'EURe' && t.chain === p.chainName());
  if (!tk) throw new HttpError(409, `El proveedor no anuncia EURe en ${p.chainName()}`, 'fiat_token_unknown');
  if (tk.address.toLowerCase() !== asset.contract_address.toLowerCase() || tk.decimals !== 18) {
    throw new HttpError(409, `El contrato EURe del proveedor (${tk.address}) no coincide con el del catálogo (${asset.contract_address}): alta detenida`, 'fiat_token_mismatch');
  }

  // 1. cuenta y dirección reservada
  let acc = await tx(async (c) => {
    await c.query('SELECT pg_advisory_xact_lock(856016)');
    const cur = await currentAccount(c, true);
    if (cur) return cur;
    const i = (await c.query(`SELECT nextval('deposit_address_index')::int AS i`)).rows[0].i as number;
    const address = keyring.derive(i).address().toLowerCase();
    const { rows: [w] } = await c.query(
      `INSERT INTO wallets (chain, network, address, purpose, custody_ref, derivation_path, derivation_index, label)
       VALUES ('ethereum',$1,$2,'fiat_treasury',$3,$4,$5,'Tesorería fiat (EURe)') RETURNING id`,
      [n.id, address, `${keyring.kind}:${i}`, `m/44'/60'/0'/0/${i}`, i]);
    const { rows: [a] } = await c.query(
      `INSERT INTO fiat_accounts (provider, mode, network, address, derivation_index, wallet_id, created_by)
       VALUES ($1,'treasury',$2,$3,$4,$5,$6) RETURNING *`, [p.name, n.id, address, i, w.id, by]);
    return a;
  });

  // 3. ligar y pedir IBAN (cada paso deja constancia; un fallo se puede reintentar)
  if (acc.status === 'pending_link') {
    const r = await p.linkAddress({ address: acc.address, signer: keyring.derive(acc.derivation_index) });
    acc = (await pool.query(`UPDATE fiat_accounts SET status = 'linked', profile_id = $2, provider_state = $3, updated_at = now() WHERE id = $1 RETURNING *`,
      [acc.id, await p.profileId(), `address:${r.state}`])).rows[0];
    log?.info({ address: acc.address, state: r.state }, 'fiat: dirección ligada al perfil del proveedor');
  }
  if (acc.status === 'linked') {
    const existing = await p.getIban(acc.address);
    if (!existing) await p.requestIban({ address: acc.address });
    acc = (await pool.query(`UPDATE fiat_accounts SET status = 'iban_requested', updated_at = now() WHERE id = $1 RETURNING *`, [acc.id])).rows[0];
  }
  acc = await refreshIban(p, acc);

  // 4. Alchemy: la dirección de tesorería entra al webhook Address Activity de la red (acelera la detección)
  const { rows: [w] } = await pool.query('SELECT id, webhook_registered FROM wallets WHERE id = $1', [acc.wallet_id]);
  if (w && !w.webhook_registered) {
    try { if (await registerOnWebhook(n, [acc.address])) await pool.query('UPDATE wallets SET webhook_registered = true WHERE id = $1', [w.id]); }
    catch (e) { log?.warn({ err: (e as Error).message }, 'fiat: dirección no registrada aún en el webhook (el worker reintenta)'); }
  }
  return status();
}

async function refreshIban(p: FiatProvider, acc: Record<string, any>) {
  if (acc.status !== 'iban_requested' && acc.status !== 'active') return acc;
  const ib = await p.getIban(acc.address);
  if (!ib) return acc;
  const active = ib.state === 'approved';
  return (await pool.query(
    `UPDATE fiat_accounts SET iban = $2, bic = $3, beneficiary = $4, provider_state = $5,
            status = CASE WHEN $6 THEN 'active' ELSE status END, updated_at = now() WHERE id = $1 RETURNING *`,
    [acc.id, ib.iban, ib.bic, ib.name, `iban:${ib.state}`, active])).rows[0];
}

// ═════════════ Portal: instrucciones y avisos ═════════════
async function readyAccount() {
  provider();
  const acc = await currentAccount();
  if (!acc || acc.status !== 'active' || !acc.iban) {
    throw new HttpError(409, 'La recepción de euros aún no está disponible (IBAN en trámite con el proveedor)', 'fiat_not_ready');
  }
  return acc;
}

export async function instructions(clientId: string) {
  const acc = await readyAccount();
  const asset = await fiatAsset();
  const { rows: [cl] } = await pool.query('SELECT counterparty_code FROM clients WHERE id = $1', [clientId]);
  return {
    currency: 'EUR', method: 'SEPA', iban: acc.iban, bic: acc.bic, beneficiary: acc.beneficiary,
    asset_id: asset.id, network: acc.network, intent_ttl_days: config.FIAT_INTENT_TTL_DAYS, counterparty_code: cl?.counterparty_code ?? null,
    steps: [
      'Cree un aviso de pago con el monto: recibirá una referencia 856-XXXX-XXXX-NNN.',
      'Transfiera por SEPA desde su banco al IBAN indicado y ponga esa referencia como concepto, sin texto adicional.',
      'Al recibirse y conciliarse, el depósito aparece como «Recibido, pendiente de liberación»; tesorería lo libera a su saldo en EURe.',
    ],
  };
}

const INTENT_COLS = `i.id, i.reference, i.expected_amount::text AS expected_amount, i.currency, i.expected_date, i.note, i.expires_at,
  i.status, i.origin_kind, i.origin_ref, i.created_by, i.matched_deposit_id, i.cancelled_by, i.cancelled_at, i.created_at, i.created_at::text AS _ts`;
const intentView = (r: Record<string, any>) => ({ ...r, expected_amount_eur: centsToEur(r.expected_amount) });

export async function createIntent(p: PortalPrincipal, b: { amount: string; expected_date?: string; note?: string }, meta: { ip: string; signature?: string }) {
  const origin = tradeOrigin(p); // usuario operator+ o llave Ed25519 con permiso trade
  await readyAccount();
  const cents = eurToCents(b.amount);
  if (cents == null) throw new HttpError(400, 'Monto inválido: euros con hasta 2 decimales (p. ej. "1250.50")', 'invalid_amount');
  const { rows: [cl] } = await pool.query('SELECT status FROM clients WHERE id = $1', [p.clientId]);
  if (cl?.status !== 'active') throw new HttpError(422, 'Su cuenta no está activa', 'client_not_active');
  for (let i = 0; ; i++) {
    try {
      const { rows: [r] } = await pool.query(
        `INSERT INTO fiat_payment_intents (client_id, reference, expected_amount, expected_date, note, expires_at,
            origin_kind, origin_ref, origin_ip, origin_signature, created_by)
         VALUES ($1,$2,$3,$4,$5, now() + make_interval(days => $6), $7,$8,$9,$10,$11)
         RETURNING id`,
        [p.clientId, newReference(), cents.toString(), b.expected_date ?? null, b.note ?? null, config.FIAT_INTENT_TTL_DAYS,
          origin.kind, origin.ref, meta.ip, origin.kind === 'client_key' ? meta.signature ?? null : null, origin.actor]);
      return getIntent(p.clientId, r.id);
    } catch (e) {
      if ((e as { code?: string }).code === '23505' && i < 5) continue; // colisión de referencia: otra
      throw e;
    }
  }
}

export async function getIntent(clientId: string, id: string) {
  await expireIntents();
  const { rows: [r] } = await pool.query(`SELECT ${INTENT_COLS} FROM fiat_payment_intents i WHERE i.id = $1 AND i.client_id = $2`, [id, clientId]);
  if (!r) throw new HttpError(404, 'Aviso no encontrado', 'not_found');
  const { _ts, ...rest } = r;
  return intentView(rest);
}

export async function listIntents(clientId: string, f: { status?: string; limit: number; cursor?: string }) {
  await expireIntents();
  const cur = decodeCursor(f.cursor);
  const { rows } = await pool.query(
    `SELECT ${INTENT_COLS} FROM fiat_payment_intents i WHERE i.client_id = $1 AND ($2::text IS NULL OR i.status = $2)
        AND ($3::timestamptz IS NULL OR (i.created_at, i.id) < ($3::timestamptz, $4::uuid))
      ORDER BY i.created_at DESC, i.id DESC LIMIT $5`,
    [clientId, f.status ?? null, cur?.[0] ?? null, cur?.[1] ?? null, f.limit + 1]);
  const pg = page(rows, f.limit);
  return { ...pg, items: pg.items.map(intentView) };
}

export async function cancelIntent(p: PortalPrincipal, id: string) {
  const origin = tradeOrigin(p);
  const { rows: [r] } = await pool.query(
    `UPDATE fiat_payment_intents SET status = 'cancelled', cancelled_by = $3, cancelled_at = now(), updated_at = now()
      WHERE id = $1 AND client_id = $2 AND status = 'open' RETURNING id`, [id, p.clientId, origin.actor]);
  if (!r) {
    const { rows: [x] } = await pool.query('SELECT status FROM fiat_payment_intents WHERE id = $1 AND client_id = $2', [id, p.clientId]);
    if (!x) throw new HttpError(404, 'Aviso no encontrado', 'not_found');
    throw new HttpError(409, `El aviso no está abierto (estado: ${x.status})`, 'intent_not_open');
  }
  return getIntent(p.clientId, id);
}

export async function expireIntents(c: Tx | typeof pool = pool) {
  await c.query(`UPDATE fiat_payment_intents SET status = 'expired', updated_at = now() WHERE status = 'open' AND expires_at <= now()`);
}

// ═════════════ Depósitos: vistas ═════════════
const DEP_COLS = `d.id, d.provider, d.provider_order_id, d.amount_cents::text AS amount_cents, d.token_amount::text AS token_amount, d.asset_id,
  d.currency, d.reference, d.payer_iban_masked, d.payer_name, d.network, d.tx_hash, d.confirmations, d.client_id, d.intent_id, d.match_rule,
  d.review_reason, d.entry_id, d.status, d.released_by, d.released_at, d.reason, d.provider_state, d.received_at, d.minted_at,
  d.reconciled_at, d.updated_at, d.received_at::text AS _ts, c.name AS client_name, i.reference AS intent_reference`;
const depView = (r: Record<string, any>) => ({ ...r, amount_eur: centsToEur(r.amount_cents) });

export async function listDepositsConsole(f: { status?: string; client_id?: string; limit: number; cursor?: string }) {
  const cur = decodeCursor(f.cursor);
  const { rows } = await pool.query(
    `SELECT ${DEP_COLS} FROM fiat_deposits d LEFT JOIN clients c ON c.id = d.client_id LEFT JOIN fiat_payment_intents i ON i.id = d.intent_id
      WHERE ($1::text IS NULL OR d.status = $1) AND ($2::uuid IS NULL OR d.client_id = $2)
        AND ($3::timestamptz IS NULL OR (d.received_at, d.id) < ($3::timestamptz, $4::uuid))
      ORDER BY d.received_at DESC, d.id DESC LIMIT $5`,
    [f.status ?? null, f.client_id ?? null, cur?.[0] ?? null, cur?.[1] ?? null, f.limit + 1]);
  const pg = page(rows, f.limit);
  return { ...pg, items: pg.items.map(depView) };
}

/** Portal: solo lo ya conciliado a su nombre (o liberado/rechazado). Nada de otros clientes ni de la cola de revisión. */
export async function listDepositsPortal(clientId: string, f: { limit: number; cursor?: string }) {
  const cur = decodeCursor(f.cursor);
  const { rows } = await pool.query(
    `SELECT d.id, d.amount_cents::text AS amount_cents, d.token_amount::text AS token_amount, d.asset_id, d.currency, d.reference,
            d.payer_name, d.network, d.tx_hash, d.status, d.reason, d.received_at, d.reconciled_at, d.released_at,
            i.reference AS intent_reference, d.received_at::text AS _ts
       FROM fiat_deposits d LEFT JOIN fiat_payment_intents i ON i.id = d.intent_id
      WHERE d.client_id = $1 AND d.status IN ('reconciled','released','rejected')
        AND ($2::timestamptz IS NULL OR (d.received_at, d.id) < ($2::timestamptz, $3::uuid))
      ORDER BY d.received_at DESC, d.id DESC LIMIT $4`,
    [clientId, cur?.[0] ?? null, cur?.[1] ?? null, f.limit + 1]);
  const pg = page(rows, f.limit);
  const label: Record<string, string> = { reconciled: 'Recibido, pendiente de liberación', released: 'Acreditado', rejected: 'Rechazado' };
  return { ...pg, items: pg.items.map((r: Record<string, any>) => ({ ...r, amount_eur: centsToEur(r.amount_cents), status_label: label[r.status] })) };
}

async function getDeposit(c: Tx | typeof pool, id: string) {
  const { rows: [r] } = await c.query(
    `SELECT ${DEP_COLS} FROM fiat_deposits d LEFT JOIN clients c ON c.id = d.client_id LEFT JOIN fiat_payment_intents i ON i.id = d.intent_id WHERE d.id = $1`, [id]);
  if (!r) throw new HttpError(404, 'Depósito fiat no encontrado', 'not_found');
  const { _ts, ...rest } = r;
  return depView(rest);
}

// ═════════════ Consola: liberar / rechazar (tesorero con 2FA; la ruta valida rol y código) ═════════════
export async function release(id: string, by: string, b: { client_id?: string; reason?: string }) {
  await tx(async (c) => {
    const { rows: [d] } = await c.query('SELECT * FROM fiat_deposits WHERE id = $1 FOR UPDATE', [id]);
    if (!d) throw new HttpError(404, 'Depósito fiat no encontrado', 'not_found');
    if (d.status !== 'reconciled' && d.status !== 'review') {
      throw new HttpError(409, `Solo se libera un depósito conciliado o en revisión (estado: ${d.status})`, 'not_releasable');
    }
    if (d.status === 'review' && !d.tx_hash) throw new HttpError(409, 'El depósito no tiene acuñación verificada on-chain: no se puede liberar', 'not_minted');
    const manual = d.status === 'review' || (b.client_id && b.client_id !== d.client_id);
    const clientId = manual ? b.client_id : d.client_id;
    if (!clientId) throw new HttpError(422, 'Asigne el cliente (client_id) para liberar un depósito en revisión', 'client_required');
    if (manual && (!b.reason || b.reason.trim().length < 5)) throw new HttpError(422, 'La asignación manual exige motivo (mín. 5 caracteres)', 'reason_required');
    const { rows: [cl] } = await c.query('SELECT status FROM clients WHERE id = $1', [clientId]);
    if (!cl) throw new HttpError(404, 'Cliente no encontrado', 'not_found');
    if (cl.status === 'closed') throw new HttpError(409, 'El cliente está cerrado', 'client_closed');
    const acc = await openClientAccount(c, clientId, d.asset_id);
    // Mismo cargo que un depósito on-chain: la custodia (EURe en la dirección de tesorería) sube, la deuda con el cliente sube
    const e = await postEntryIn(c, {
      kind: 'deposit', description: `Depósito SEPA → EURe (orden ${d.provider_order_id})`, external_ref: d.tx_hash,
      idempotency_key: `fiat:${d.provider}:${d.provider_order_id}`,
      metadata: { fiat_deposit_id: d.id, released_by: by, match_rule: manual ? 'manual' : d.match_rule, amount_eur: centsToEur(d.amount_cents) },
      postings: [
        { account: `system:${d.asset_id}:custody`, direction: 'debit', amount: d.token_amount },
        { account: acc.id, direction: 'credit', amount: d.token_amount },
      ],
    });
    await c.query(
      `UPDATE fiat_deposits SET status = 'released', client_id = $2, entry_id = $3, released_by = $4, released_at = now(),
              match_rule = $5, reason = COALESCE($6, reason), updated_at = now() WHERE id = $1`,
      [id, clientId, e.id, by, manual ? 'manual' : d.match_rule, manual ? b.reason!.trim() : null]);
  });
  return getDeposit(pool, id);
}

export async function reject(id: string, by: string, reason: string) {
  const { rows: [r] } = await pool.query(
    `UPDATE fiat_deposits SET status = 'rejected', reason = $3, released_by = $2, released_at = now(), updated_at = now()
      WHERE id = $1 AND status IN ('received','minted','reconciled','review') RETURNING id`, [id, by, reason.trim()]);
  if (!r) {
    const { rows: [x] } = await pool.query('SELECT status FROM fiat_deposits WHERE id = $1', [id]);
    if (!x) throw new HttpError(404, 'Depósito fiat no encontrado', 'not_found');
    throw new HttpError(409, `El depósito ya está cerrado (estado: ${x.status})`, 'not_rejectable');
  }
  return getDeposit(pool, id);
}

// ═════════════ Conciliación (worker) ═════════════
const maskIban = (iban: string | null) => (iban ? `${iban.slice(0, 4)}…${iban.slice(-4)}` : null);
let lastPoll = 0;
let kick = false;
/** Webhook (Monerium o Alchemy hacia la tesorería): adelanta el siguiente sondeo. Nunca mueve estado por sí solo. */
export const kickPoll = () => { kick = true; };

/** Un ciclo: refresca el IBAN, sondea órdenes, verifica acuñaciones on-chain y concilia. Idempotente. */
export async function fiatTick(log: Log, force = false) {
  const p = getFiatProvider();
  if (!p) return { skipped: 'fiat apagado' };
  const n = findNet(fiatNetworkId());
  if (!n?.healthy) return { skipped: `red ${fiatNetworkId()} fuera de servicio` };
  if (!force && !kick && Date.now() - lastPoll < config.FIAT_POLL_INTERVAL_MS) return { skipped: 'intervalo' };
  kick = false; lastPoll = Date.now();
  let acc = await currentAccount();
  if (!acc) return { skipped: 'sin cuenta fiat (alta pendiente en la consola)' };
  const out = { orders: 0, minted: 0, reconciled: 0, review: 0 };
  try {
    acc = await refreshIban(p, acc);
    await expireIntents();
    const asset = await fiatAsset();
    for (const o of await p.listOrders(acc.address)) {
      if (o.kind !== 'issue') continue; // esta fase solo entrada
      out.orders++;
      await upsertOrder(acc, asset.id, n.id, o, log);
    }
    out.minted = await verifyMints(n, acc, asset, log);
    const r = await assignReconciled(log);
    out.reconciled = r.reconciled; out.review = r.review;
    await pool.query(`INSERT INTO fiat_sync_state (provider, last_poll_at, last_error) VALUES ($1, now(), NULL)
      ON CONFLICT (provider) DO UPDATE SET last_poll_at = now(), last_error = NULL, updated_at = now()`, [p.name]);
  } catch (e) {
    const msg = (e as Error).message.slice(0, 300);
    await pool.query(`INSERT INTO fiat_sync_state (provider, last_error) VALUES ($1, $2)
      ON CONFLICT (provider) DO UPDATE SET last_error = $2, updated_at = now()`, [p.name, msg]);
    log.error({ err: msg }, 'fiat: ciclo de conciliación con error');
    return { error: msg };
  }
  return out;
}

/** Registra o avanza la orden del proveedor. Nunca retrocede un depósito ya conciliado, liberado o rechazado. */
async function upsertOrder(acc: Record<string, any>, assetId: string, network: string, o: FiatOrder, log: Log) {
  const cents = eurToCents(o.amount);
  const raw = JSON.stringify({ id: o.id, state: o.state, memo: o.memo, placed_at: o.placed_at, processed_at: o.processed_at });
  if (cents == null || o.currency !== 'eur') {
    log.warn({ order: o.id, amount: o.amount, currency: o.currency }, 'fiat: orden con monto o moneda no soportada (queda fuera; revisar en el proveedor)');
    return;
  }
  const hash = o.state === 'processed' ? o.tx_hashes[0] ?? null : null;
  await pool.query(
    `INSERT INTO fiat_deposits (fiat_account_id, provider, provider_order_id, amount_cents, token_amount, asset_id, reference,
        payer_iban_masked, payer_name, network, provider_state, provider_payload)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) ON CONFLICT (provider, provider_order_id) DO NOTHING`,
    [acc.id, acc.provider, o.id, cents.toString(), (cents * CENT_TO_TOKEN).toString(), assetId, o.memo, maskIban(o.payer_iban),
      o.payer_name, network, o.state, raw]);
  const { rows: [d] } = await pool.query('SELECT id, status, tx_hash, amount_cents FROM fiat_deposits WHERE provider = $1 AND provider_order_id = $2', [acc.provider, o.id]);
  if (BigInt(d.amount_cents) !== cents && ['received', 'minted'].includes(d.status)) {
    await toReview(d.id, 'el proveedor cambió el monto de la orden');
    return;
  }
  if (o.state === 'rejected' && ['received', 'minted'].includes(d.status)) {
    await pool.query(`UPDATE fiat_deposits SET status = 'rejected', reason = $2, provider_state = 'rejected', updated_at = now() WHERE id = $1`,
      [d.id, `rechazada por el proveedor${o.rejected_reason ? `: ${o.rejected_reason}` : ''}`]);
    return;
  }
  if (hash && d.status === 'received') {
    try {
      await pool.query(`UPDATE fiat_deposits SET status = 'minted', tx_hash = $2, minted_at = now(), provider_state = $3, updated_at = now() WHERE id = $1 AND status = 'received'`,
        [d.id, hash, o.state]);
    } catch (e) {
      // La misma transacción ya está ligada a otra orden: nunca dos asientos por un hash
      if ((e as { code?: string }).code !== '23505') throw e;
      await toReview(d.id, `transacción ${hash} ya ligada a otra orden`);
    }
  } else if (d.status === 'received') {
    await pool.query('UPDATE fiat_deposits SET provider_state = $2, updated_at = now() WHERE id = $1', [d.id, o.state]);
  }
}

async function toReview(id: string, why: string) {
  await pool.query(`UPDATE fiat_deposits SET status = 'review', review_reason = $2, updated_at = now() WHERE id = $1 AND status IN ('received','minted')`, [id, why]);
}

/** Acuñación verificada: Transfer del contrato EURe hacia la dirección de tesorería por el monto exacto, con confirmaciones. */
async function verifyMints(n: Net, acc: Record<string, any>, asset: { id: string; contract_address: string }, log: Log) {
  const { rows } = await pool.query(`SELECT id, tx_hash, token_amount FROM fiat_deposits WHERE status = 'minted' AND network = $1 ORDER BY received_at`, [n.id]);
  if (!rows.length) return 0;
  const head = await n.client.getBlockNumber({ cacheTime: 0 });
  let done = 0;
  for (const d of rows) {
    const receipt = await n.client.getTransactionReceipt({ hash: d.tx_hash as Hash }).catch(() => null);
    if (!receipt) continue; // aún no visible: siguiente ciclo
    if (receipt.status !== 'success') { await toReview(d.id, 'la transacción de acuñación revirtió'); continue; }
    let hit: { amount: bigint; log_index: number } | null = null;
    for (const lg of receipt.logs) {
      if (lg.address.toLowerCase() !== asset.contract_address.toLowerCase() || lg.topics[0] !== TRANSFER_TOPIC) continue;
      const ev = decodeEventLog({ abi: erc20Abi, data: lg.data, topics: lg.topics });
      const { to, value } = ev.args as { to: Address; value: bigint };
      if (ev.eventName === 'Transfer' && to.toLowerCase() === acc.address) { hit = { amount: value, log_index: lg.logIndex }; break; }
    }
    if (!hit) { await toReview(d.id, 'la transacción no transfiere EURe a la dirección de tesorería'); continue; }
    if (hit.amount !== BigInt(d.token_amount)) {
      const asEur = (v: bigint) => (v % CENT_TO_TOKEN === 0n ? `${centsToEur(v / CENT_TO_TOKEN)} €` : `${v} unidades base`);
      await toReview(d.id, `monto acuñado (${asEur(hit.amount)}) distinto al de la orden (${asEur(BigInt(d.token_amount))})`);
      continue;
    }
    const confs = Number(head - receipt.blockNumber + 1n);
    await pool.query('UPDATE fiat_deposits SET confirmations = $2, block_number = $3, log_index = $4, updated_at = now() WHERE id = $1',
      [d.id, confs, receipt.blockNumber.toString(), hit.log_index]);
    if (confs < n.confirmations) continue;
    await pool.query(`UPDATE fiat_deposits SET status = 'reconciled', reconciled_at = now(), updated_at = now() WHERE id = $1 AND status = 'minted'`, [d.id]);
    done++;
    log.info({ fiat_deposit: d.id, tx: d.tx_hash }, 'fiat: acuñación verificada on-chain');
  }
  return done;
}

/**
 * Asignación de lo conciliado sin cliente: 1) referencia de un aviso abierto del mismo monto; 2) código de contraparte;
 * si nada coincide (o la referencia es de otro cliente, está vencida o el monto difiere) → revisión de tesorería.
 */
async function assignReconciled(log: Log) {
  const { rows } = await pool.query(`SELECT id, reference, amount_cents FROM fiat_deposits WHERE status = 'reconciled' AND client_id IS NULL ORDER BY received_at`);
  let reconciled = 0, review = 0;
  for (const d of rows) {
    const verdict = await tx(async (c) => {
      const m = parseMemo(d.reference);
      if (m.reference) {
        if (!m.reference_valid) return { review: `referencia ${m.reference} con dígitos de control inválidos` };
        const { rows: [i] } = await c.query('SELECT * FROM fiat_payment_intents WHERE reference = $1 FOR UPDATE', [m.reference]);
        if (!i) return { review: `referencia ${m.reference} inexistente` };
        if (i.status !== 'open') return { review: `aviso ${m.reference} ${INTENT_ES[i.status as string] ?? i.status}` };
        if (new Date(i.expires_at) <= new Date()) return { review: `aviso ${m.reference} vencido` };
        if (BigInt(i.expected_amount) !== BigInt(d.amount_cents)) {
          return { review: `monto ${centsToEur(d.amount_cents)} distinto al del aviso ${m.reference} (${centsToEur(i.expected_amount)})` };
        }
        await c.query(`UPDATE fiat_payment_intents SET status = 'matched', matched_deposit_id = $2, updated_at = now() WHERE id = $1`, [i.id, d.id]);
        await c.query(`UPDATE fiat_deposits SET client_id = $2, intent_id = $3, match_rule = 'intent', updated_at = now() WHERE id = $1`, [d.id, i.client_id, i.id]);
        return { client: i.client_id };
      }
      if (m.counterparty_code) {
        const { rows: [cl] } = await c.query(`SELECT id FROM clients WHERE counterparty_code = $1 AND status <> 'closed'`, [m.counterparty_code]);
        if (!cl) return { review: `código de contraparte ${m.counterparty_code} inexistente` };
        await c.query(`UPDATE fiat_deposits SET client_id = $2, match_rule = 'counterparty', updated_at = now() WHERE id = $1`, [d.id, cl.id]);
        return { client: cl.id };
      }
      return { review: 'sin referencia de aviso ni código de contraparte en el concepto' };
    });
    if ('review' in verdict) {
      await pool.query(`UPDATE fiat_deposits SET status = 'review', review_reason = $2, updated_at = now() WHERE id = $1 AND status = 'reconciled'`, [d.id, verdict.review]);
      review++;
      log.warn({ fiat_deposit: d.id, reason: verdict.review }, 'fiat: depósito en revisión');
    } else reconciled++;
  }
  return { reconciled, review };
}

/** Solo fuera de production (proveedor simulado): registra una orden de entrada como si llegara por SEPA. */
export async function simulateOrder(b: { amount: string; memo?: string; payer_name?: string; payer_iban?: string; tx_hash?: string; state?: 'pending' | 'processed' | 'rejected' }) {
  const mock = mockProvider();
  if (!mock) throw new HttpError(403, 'La simulación solo existe con el proveedor simulado (sandbox)', 'simulation_disabled');
  const acc = await currentAccount();
  if (!acc) throw new HttpError(409, 'Primero dé de alta la cuenta fiat', 'fiat_not_ready');
  const o = mock.simulateOrder({ address: acc.address, amount: b.amount, memo: b.memo, payer_name: b.payer_name, payer_iban: b.payer_iban,
    tx_hash: b.tx_hash, state: b.state });
  kickPoll();
  return { order_id: o.id, state: o.state, address: acc.address };
}

/** Simulación: la misma orden pasa a «processed» con su hash de acuñación. */
export async function simulateProcess(orderId: string, txHash: string) {
  const mock = mockProvider();
  if (!mock) throw new HttpError(403, 'La simulación solo existe con el proveedor simulado (sandbox)', 'simulation_disabled');
  const acc = await currentAccount();
  const cur = (await mock.listOrders(acc?.address ?? '')).find((o) => o.id === orderId);
  if (!cur) throw new HttpError(404, 'Orden simulada no encontrada', 'not_found');
  mock.simulateOrder({ ...cur, id: orderId, tx_hash: txHash, state: 'processed' });
  kickPoll();
  return { order_id: orderId, state: 'processed' };
}
