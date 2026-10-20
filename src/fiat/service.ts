// Fase F1 — entrada SEPA → EURe en modo tesorería única.
//
//  cliente: aviso de pago (referencia 856-XXXX-XXXX-NNN) → transfiere por SEPA con esa referencia
//  proveedor: registra la orden (received) → acuña EURe en la dirección de tesorería fiat (minted)
//  856: concilia orden + transferencia on-chain confirmada (mismo hash, mismo monto) → reconciled | review
//  tesorero: libera con 2FA (released → asiento custodia / cliente) o rechaza con motivo (rejected)
// Solo «released» mueve saldo disponible. Acreditar es proceso de sistema (compatible con ORIGIN_RULE=enforce).
import { createHash, randomInt } from 'node:crypto';
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
import { fiatIdempotencyKey, toFiatTransactionStatus } from './domain.js';
import { activeRailsFor, assertIntentRailOpen, railState } from './rails.js';
import type { CryptoCustodyPort } from './ports.js';
import { EvmFiatCustodyAdapter } from './evm-custody.js';

type Log = { info: (o: object, m: string) => void; warn: (o: object, m: string) => void; error: (o: object, m: string) => void };
const CENT_TO_TOKEN = 10n ** 16n; // EURe tiene 18 decimales; el EUR, 2
const fiatCustody: CryptoCustodyPort = new EvmFiatCustodyAdapter();
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
    `SELECT * FROM fiat_accounts WHERE provider = $1 AND mode = 'treasury' AND network = $2 AND status <> 'closed'
      ${lock ? 'FOR UPDATE' : ''}`, [p.name, fiatNetworkId()]);
  return a ?? null;
}
async function clientAccount(clientId: string, c: Tx | typeof pool = pool, lock = false) {
  const p = getFiatProvider();
  if (!p) return null;
  const { rows: [a] } = await c.query(
    `SELECT * FROM fiat_accounts WHERE provider = $1 AND mode = 'per_client' AND client_id = $2
      AND network = $3 AND status <> 'closed' ${lock ? 'FOR UPDATE' : ''}`, [p.name, clientId, fiatNetworkId()]);
  return a ?? null;
}
const accountView = (a: Record<string, unknown> | null) => a && {
  id: a.id, provider: a.provider, mode: a.mode, client_id: a.client_id, status: a.status, iban: a.iban, bic: a.bic, beneficiary: a.beneficiary,
  network: a.network, address: a.address, provider_state: a.provider_state, created_at: a.created_at, updated_at: a.updated_at,
};

// ═════════════ Consola: estado y alta ═════════════
export async function status() {
  const p = getFiatProvider();
  const acc = config.FIAT_MODE === 'treasury' ? await currentAccount() : null;
  const { rows: [s] } = p ? await pool.query('SELECT last_poll_at, last_error FROM fiat_sync_state WHERE provider = $1', [p.name]) : { rows: [] };
  const { rows: [q] } = await pool.query(
    `SELECT count(*) FILTER (WHERE status = 'reconciled')::int AS reconciled, count(*) FILTER (WHERE status = 'review')::int AS review,
            count(*) FILTER (WHERE status IN ('received','minted'))::int AS in_flight FROM fiat_deposits WHERE network = $1`,
    [fiatNetworkId()]);
  return {
    enabled: !!p, provider: p?.name ?? null, live: p?.live ?? false, live_switch: config.FIAT_LIVE_ENABLED, mode: config.FIAT_MODE,
    network: fiatNetworkId(), account: accountView(acc), last_poll_at: s?.last_poll_at ?? null, last_error: s?.last_error ?? null,
    provider_calls: providerCalls(), queue: q,
  };
}

export async function listAccountsConsole() {
  const { rows } = await pool.query(
    `SELECT a.id, a.provider, a.mode, a.client_id, c.name AS client_name, a.status, a.iban, a.bic, a.beneficiary,
            a.network, a.address, a.provider_state, a.created_at, a.updated_at
       FROM fiat_accounts a LEFT JOIN clients c ON c.id = a.client_id
      ORDER BY a.created_at DESC, a.id`);
  return rows;
}

export async function closeClientAccount(id: string, by: string, reason: string) {
  return tx(async (c) => {
    const { rows: [a] } = await c.query(
      `SELECT * FROM fiat_accounts WHERE id = $1 AND mode = 'per_client' FOR UPDATE`, [id]);
    if (!a) throw new HttpError(404, 'Cuenta fiat por cliente no encontrada', 'not_found');
    if (a.status === 'closed') return accountView(a);
    const { rows: [open] } = await c.query(
      `SELECT count(*)::int AS n FROM fiat_deposits
        WHERE fiat_account_id = $1 AND status IN ('received','minted','reconciled','review')`, [id]);
    if (open.n) throw new HttpError(409, `No se puede cerrar: hay ${open.n} depósitos sin resolver`, 'fiat_account_has_open_deposits');
    await c.query(
      `UPDATE fiat_payment_intents SET status = 'cancelled', cancelled_by = $2, cancelled_at = now(), updated_at = now()
        WHERE fiat_account_id = $1 AND status = 'open'`, [id, by]);
    await c.query(`UPDATE fiat_accounts SET status = 'closed', provider_state = 'closed_locally', updated_at = now() WHERE id = $1`, [id]);
    return accountView({ ...a, status: 'closed', provider_state: 'closed_locally' });
  });
}

/**
 * Alta / avance del alta (idempotente; se puede repetir para refrescar el IBAN):
 *  1. reserva una dirección HD de 856 (índice propio, nunca una wallet personal) en la red de fiat
 *  2. verifica que el EURe que anuncia el proveedor sea el mismo contrato del catálogo
 *  3. liga la dirección al perfil (firma de mensaje de propiedad, sin gas) y pide el IBAN
 *  4. registra la dirección en el webhook Address Activity de Alchemy de esa red (el de M1; no se crea otro)
 */
export async function setup(by: string, log?: Log) {
  if (config.FIAT_MODE !== 'treasury') throw new HttpError(409, 'En modo per_client active una cuenta desde el cliente objetivo', 'fiat_mode_mismatch');
  return provisionAccount({ mode: 'treasury', clientId: null, providerId: provider().name, by, log });
}

export async function activateClientAccount(clientId: string, providerId: string, by: string, log?: Log) {
  if (config.FIAT_MODE !== 'per_client') throw new HttpError(409, 'La activación por cliente requiere FIAT_MODE=per_client', 'fiat_mode_mismatch');
  const result = await provisionAccount({ mode: 'per_client', clientId, providerId, by, log });
  return result.account;
}

async function provisionAccount(input: {
  mode: 'treasury' | 'per_client'; clientId: string | null; providerId: string; by: string; log?: Log;
}) {
  const p = getFiatProvider(input.providerId);
  if (!p) throw new HttpError(503, 'Entrada de fiat apagada en este despliegue', 'fiat_disabled');
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
    await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`fiat_account:${input.mode}:${input.clientId ?? p.name}`]);
    if (input.clientId) {
      const { rows: [cl] } = await c.query('SELECT status FROM clients WHERE id = $1 FOR UPDATE', [input.clientId]);
      if (!cl) throw new HttpError(404, 'Cliente no encontrado', 'not_found');
      if (cl.status !== 'active') throw new HttpError(409, 'Solo se puede activar fiat para clientes activos', 'client_not_eligible');
      const { rows: [other] } = await c.query(
        `SELECT provider FROM fiat_accounts WHERE client_id = $1 AND mode = 'per_client' AND network = $3
          AND status <> 'closed' AND provider <> $2 LIMIT 1`, [input.clientId, p.name, n.id]);
      if (other) throw new HttpError(409, `Cierre la cuenta ${other.provider} antes de cambiar el proveedor`, 'provider_change_requires_close');
    }
    const cur = input.clientId
      ? await clientAccount(input.clientId, c, true)
      : await currentAccount(c, true);
    if (cur) return cur;
    const i = (await c.query(`SELECT nextval('deposit_address_index')::int AS i`)).rows[0].i as number;
    const address = keyring.derive(i).address().toLowerCase();
    const { rows: [w] } = await c.query(
      `INSERT INTO wallets (client_id, chain, network, address, purpose, custody_ref, derivation_path, derivation_index, label)
       VALUES ($1,'ethereum',$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
      [input.clientId, n.id, address, input.clientId ? 'fiat_client' : 'fiat_treasury',
        `${keyring.kind}:${i}`, `m/44'/60'/0'/0/${i}`, i, input.clientId ? `Cuenta fiat cliente ${input.clientId}` : 'Tesorería fiat (EURe)']);
    const { rows: [a] } = await c.query(
      `INSERT INTO fiat_accounts (provider, mode, client_id, network, address, derivation_index, wallet_id, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [p.name, input.mode, input.clientId, n.id, address, i, w.id, input.by]);
    return a;
  });

  // 3. ligar y pedir IBAN (cada paso deja constancia; un fallo se puede reintentar)
  if (acc.status === 'pending_link') {
    const r = await p.linkAddress({ address: acc.address, signer: keyring.derive(acc.derivation_index) });
    acc = (await pool.query(`UPDATE fiat_accounts SET status = 'linked', profile_id = $2, provider_state = $3, updated_at = now() WHERE id = $1 RETURNING *`,
      [acc.id, await p.profileId(), `address:${r.state}`])).rows[0];
    input.log?.info({ address: acc.address, state: r.state }, 'fiat: dirección ligada al perfil del proveedor');
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
    catch (e) { input.log?.warn({ err: (e as Error).message }, 'fiat: dirección no registrada aún en el webhook (el worker reintenta)'); }
  }
  if (input.mode === 'treasury') return status();
  const { rows: [s] } = await pool.query('SELECT last_poll_at, last_error FROM fiat_sync_state WHERE provider = $1', [p.name]);
  return { account: accountView(acc), last_poll_at: s?.last_poll_at ?? null, last_error: s?.last_error ?? null };
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
async function readyAccount(clientId: string) {
  provider();
  if (config.FIAT_MODE === 'per_client') {
    const { rows: [cl] } = await pool.query('SELECT status FROM clients WHERE id = $1', [clientId]);
    if (cl?.status !== 'active') throw new HttpError(409, 'Solo clientes activos pueden recibir euros', 'client_not_eligible');
  }
  const acc = config.FIAT_MODE === 'per_client' ? await clientAccount(clientId) : await currentAccount();
  if (!acc || acc.status !== 'active' || !acc.iban) {
    throw new HttpError(409, 'La recepción de euros aún no está disponible (IBAN en trámite con el proveedor)', 'fiat_not_ready');
  }
  return acc;
}

/** Instrucciones del portal. Aditivo: conserva los campos EUR (Monerium) y suma active_rails con los rieles encendidos. */
export async function instructions(clientId: string, amount?: string) {
  const rails = await activeRailsFor(clientId, amount);
  const eur = await railState('monerium-eur', clientId);
  const eurHidden = !!eur && !eur.visible;
  let legacy: Awaited<ReturnType<typeof eurInstructions>> | null = null;
  try {
    if (eurHidden) throw new HttpError(409, 'La recepción de euros no está disponible para su empresa', 'fiat_not_ready');
    legacy = await eurInstructions(clientId);
  } catch (e) {
    // Sin IBAN de Monerium, pero con otros rieles encendidos, el cliente aún puede ver las instrucciones de esos rieles
    if (!(e instanceof HttpError) || !rails.active_rails.some((r) => r.kind === 'manual')) throw e;
  }
  const { rows: [o] } = await pool.query(`SELECT count(*)::int AS n FROM fiat_payment_intents WHERE client_id = $1 AND status = 'open'`, [clientId]);
  const notice = eur && eur.visible && !eur.enabled && o.n > 0
    ? 'El riel SEPA automático está en pausa: los avisos de pago ya abiertos siguen vigentes, pero no se pueden crear avisos nuevos.' : null;
  return { ...(legacy ?? {}), ...rails, eur_rail: eurHidden || !eur ? null : { rail_id: eur.rail_id, enabled: eur.enabled, maintenance_message: eur.maintenance_message }, notice };
}

async function eurInstructions(clientId: string) {
  const acc = await readyAccount(clientId);
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

const INTENT_COLS = `i.id, i.fiat_account_id, i.provider, i.reference, i.expected_amount::text AS expected_amount, i.currency, i.expected_date, i.note, i.expires_at,
  i.status, i.origin_kind, i.origin_ref, i.created_by, i.matched_deposit_id, i.cancelled_by, i.cancelled_at, i.created_at, i.created_at::text AS _ts`;
const intentView = (r: Record<string, any>) => ({ ...r, expected_amount_eur: centsToEur(r.expected_amount) });
const intentAccountScope = config.FIAT_MODE === 'per_client'
  ? `EXISTS (SELECT 1 FROM fiat_accounts a WHERE a.id = i.fiat_account_id AND a.mode = 'per_client'
       AND a.client_id = i.client_id AND a.provider = i.provider AND a.network = '${fiatNetworkId()}')`
  : `EXISTS (SELECT 1 FROM fiat_accounts a
       WHERE a.id = i.fiat_account_id AND a.mode = 'treasury' AND a.provider = i.provider AND a.network = '${fiatNetworkId()}')`;

export async function createIntent(p: PortalPrincipal, b: { amount: string; expected_date?: string; note?: string }, meta: { ip: string; signature?: string }) {
  const origin = tradeOrigin(p); // usuario operator+ o llave Ed25519 con permiso trade
  const acc = await readyAccount(p.clientId);
  await assertIntentRailOpen('monerium-eur', p.clientId);
  const cents = eurToCents(b.amount);
  if (cents == null) throw new HttpError(400, 'Monto inválido: euros con hasta 2 decimales (p. ej. "1250.50")', 'invalid_amount');
  const { rows: [cl] } = await pool.query('SELECT status FROM clients WHERE id = $1', [p.clientId]);
  if (cl?.status !== 'active') throw new HttpError(422, 'Su cuenta no está activa', 'client_not_active');
  for (let i = 0; ; i++) {
    try {
      const { rows: [r] } = await pool.query(
        `INSERT INTO fiat_payment_intents (client_id, fiat_account_id, provider, reference, expected_amount, expected_date, note, expires_at,
            origin_kind, origin_ref, origin_ip, origin_signature, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7, now() + make_interval(days => $8), $9,$10,$11,$12,$13)
         RETURNING id`,
        [p.clientId, acc.id, acc.provider, newReference(), cents.toString(), b.expected_date ?? null, b.note ?? null, config.FIAT_INTENT_TTL_DAYS,
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
  const { rows: [r] } = await pool.query(
    `SELECT ${INTENT_COLS} FROM fiat_payment_intents i WHERE i.id = $1 AND i.client_id = $2 AND ${intentAccountScope}`,
    [id, clientId]);
  if (!r) throw new HttpError(404, 'Aviso no encontrado', 'not_found');
  const { _ts, ...rest } = r;
  return intentView(rest);
}

export async function listIntents(clientId: string, f: { status?: string; limit: number; cursor?: string }) {
  await expireIntents();
  const cur = decodeCursor(f.cursor);
  const { rows } = await pool.query(
    `SELECT ${INTENT_COLS} FROM fiat_payment_intents i WHERE i.client_id = $1 AND ${intentAccountScope}
        AND ($2::text IS NULL OR i.status = $2)
        AND ($3::timestamptz IS NULL OR (i.created_at, i.id) < ($3::timestamptz, $4::uuid))
      ORDER BY i.created_at DESC, i.id DESC LIMIT $5`,
    [clientId, f.status ?? null, cur?.[0] ?? null, cur?.[1] ?? null, f.limit + 1]);
  const pg = page(rows, f.limit);
  return { ...pg, items: pg.items.map(intentView) };
}

export async function cancelIntent(p: PortalPrincipal, id: string) {
  const origin = tradeOrigin(p);
  const { rows: [r] } = await pool.query(
    `UPDATE fiat_payment_intents i SET status = 'cancelled', cancelled_by = $3, cancelled_at = now(), updated_at = now()
      WHERE i.id = $1 AND i.client_id = $2 AND i.status = 'open' AND ${intentAccountScope} RETURNING i.id`,
    [id, p.clientId, origin.actor]);
  if (!r) {
    const { rows: [x] } = await pool.query(
      `SELECT status FROM fiat_payment_intents i WHERE i.id = $1 AND i.client_id = $2 AND ${intentAccountScope}`, [id, p.clientId]);
    if (!x) throw new HttpError(404, 'Aviso no encontrado', 'not_found');
    throw new HttpError(409, `El aviso no está abierto (estado: ${x.status})`, 'intent_not_open');
  }
  return getIntent(p.clientId, id);
}

export async function expireIntents(c: Tx | typeof pool = pool) {
  await c.query(`UPDATE fiat_payment_intents SET status = 'expired', updated_at = now() WHERE status = 'open' AND expires_at <= now()`);
}

// ═════════════ Depósitos: vistas ═════════════
const DEP_COLS = `d.id, d.fiat_account_id, d.provider, d.provider_order_id, d.amount_cents::text AS amount_cents, d.token_amount::text AS token_amount, d.asset_id,
  d.currency, d.reference, d.payer_iban_masked, d.payer_name, d.network, d.tx_hash, d.confirmations, d.client_id, d.intent_id, d.match_rule,
  d.review_reason, d.entry_id, d.status, d.released_by, d.released_at, d.reason, d.provider_state, d.received_at, d.minted_at,
  d.reconciled_at, d.updated_at, d.received_at::text AS _ts, c.name AS client_name, i.reference AS intent_reference`;
const depView = (r: Record<string, any>) => ({
  ...r, amount_eur: centsToEur(r.amount_cents), domain_status: toFiatTransactionStatus(r.status),
});

export async function listDepositsConsole(f: { status?: string; client_id?: string; limit: number; cursor?: string }) {
  const cur = decodeCursor(f.cursor);
  const { rows } = await pool.query(
    `SELECT ${DEP_COLS} FROM fiat_deposits d JOIN fiat_accounts fa ON fa.id = d.fiat_account_id
      LEFT JOIN clients c ON c.id = d.client_id LEFT JOIN fiat_payment_intents i ON i.id = d.intent_id
      WHERE ($1::text IS NULL OR d.status = $1) AND ($2::uuid IS NULL OR d.client_id = $2) AND d.network = $3
        AND (fa.mode = 'treasury' OR (fa.provider = d.provider AND fa.client_id = d.client_id))
        AND ($4::timestamptz IS NULL OR (d.received_at, d.id) < ($4::timestamptz, $5::uuid))
      ORDER BY d.received_at DESC, d.id DESC LIMIT $6`,
    [f.status ?? null, f.client_id ?? null, fiatNetworkId(), cur?.[0] ?? null, cur?.[1] ?? null, f.limit + 1]);
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
       FROM fiat_deposits d JOIN fiat_accounts a ON a.id = d.fiat_account_id
       LEFT JOIN fiat_payment_intents i ON i.id = d.intent_id
      WHERE d.client_id = $1 AND d.network = $2 AND d.status IN ('reconciled','released','rejected')
        AND (a.mode = 'treasury' OR (a.mode = 'per_client' AND a.client_id = d.client_id AND a.provider = d.provider))
        AND ($3::timestamptz IS NULL OR (d.received_at, d.id) < ($3::timestamptz, $4::uuid))
      ORDER BY d.received_at DESC, d.id DESC LIMIT $5`,
    [clientId, fiatNetworkId(), cur?.[0] ?? null, cur?.[1] ?? null, f.limit + 1]);
  const pg = page(rows, f.limit);
  const label: Record<string, string> = { reconciled: 'Recibido, pendiente de liberación', released: 'Acreditado', rejected: 'Rechazado' };
  return { ...pg, items: pg.items.map((r: Record<string, any>) => ({ ...r, amount_eur: centsToEur(r.amount_cents), status_label: label[r.status] })) };
}

async function getDeposit(c: Tx | typeof pool, id: string) {
  const { rows: [r] } = await c.query(
    `SELECT ${DEP_COLS} FROM fiat_deposits d JOIN fiat_accounts a ON a.id = d.fiat_account_id
      LEFT JOIN clients c ON c.id = d.client_id LEFT JOIN fiat_payment_intents i ON i.id = d.intent_id
      WHERE d.id = $1 AND d.network = $2 AND a.provider = d.provider
        AND (a.mode = 'treasury' OR a.client_id = d.client_id)`, [id, fiatNetworkId()]);
  if (!r) throw new HttpError(404, 'Depósito fiat no encontrado', 'not_found');
  const { _ts, ...rest } = r;
  return depView(rest);
}

// ═════════════ Consola: liberar / rechazar (tesorero con 2FA; la ruta valida rol y código) ═════════════
export async function release(id: string, by: string, b: { client_id?: string; reason?: string }) {
  await tx(async (c) => {
    const { rows: [d] } = await c.query(
      `SELECT d.*, a.mode AS account_mode, a.client_id AS account_client_id
         FROM fiat_deposits d JOIN fiat_accounts a ON a.id = d.fiat_account_id
        WHERE d.id = $1 AND d.network = $2 FOR UPDATE OF d`, [id, fiatNetworkId()]);
    if (!d) throw new HttpError(404, 'Depósito fiat no encontrado', 'not_found');
    if (d.status !== 'reconciled' && d.status !== 'review') {
      throw new HttpError(409, `Solo se libera un depósito conciliado o en revisión (estado: ${d.status})`, 'not_releasable');
    }
    if (d.status === 'review' && !d.tx_hash) throw new HttpError(409, 'El depósito no tiene acuñación verificada on-chain: no se puede liberar', 'not_minted');
    const perClient = d.account_mode === 'per_client';
    if (perClient && b.client_id && b.client_id !== d.client_id) {
      throw new HttpError(403, 'Un depósito per_client solo puede liberarse al cliente enlazado a su cuenta/proveedor', 'fiat_ownership_mismatch');
    }
    const manual = d.status === 'review' || (b.client_id && b.client_id !== d.client_id);
    const clientId = perClient ? d.client_id : manual ? b.client_id : d.client_id;
    if (!clientId) throw new HttpError(422, 'Asigne el cliente (client_id) para liberar un depósito en revisión', 'client_required');
    if (manual && (!b.reason || b.reason.trim().length < 5)) throw new HttpError(422, 'La asignación manual exige motivo (mín. 5 caracteres)', 'reason_required');
    const { rows: [cl] } = await c.query('SELECT status FROM clients WHERE id = $1', [clientId]);
    if (!cl) throw new HttpError(404, 'Cliente no encontrado', 'not_found');
    if (cl.status === 'closed') throw new HttpError(409, 'El cliente está cerrado', 'client_closed');
    if (perClient && cl.status !== 'active') throw new HttpError(409, 'El cliente per_client ya no es elegible para recibir saldo', 'client_not_eligible');
    const acc = await openClientAccount(c, clientId, d.asset_id);
    // Mismo cargo que un depósito on-chain: la custodia (EURe en la dirección de tesorería) sube, la deuda con el cliente sube
    const e = await postEntryIn(c, {
      kind: 'deposit', description: `Depósito SEPA → EURe (orden ${d.provider_order_id})`, external_ref: d.tx_hash,
      idempotency_key: perClient
        ? `fiat:${d.provider}:${d.provider_order_id}:${clientId}`
        : `fiat:${d.provider}:${d.provider_order_id}`,
      metadata: { fiat_deposit_id: d.id, released_by: by, client_id: clientId,
        provider: d.provider, match_rule: manual ? (perClient ? 'account' : 'manual') : d.match_rule, amount_eur: centsToEur(d.amount_cents) },
      postings: [
        { account: `system:${d.asset_id}:custody`, direction: 'debit', amount: d.token_amount },
        { account: acc.id, direction: 'credit', amount: d.token_amount },
      ],
    });
    await c.query(
      `UPDATE fiat_deposits SET status = 'released', client_id = $2, entry_id = $3, released_by = $4, released_at = now(),
              match_rule = $5, reason = COALESCE($6, reason), updated_at = now() WHERE id = $1`,
      [id, clientId, e.id, by, manual ? (perClient ? 'account' : 'manual') : d.match_rule, manual ? b.reason!.trim() : null]);
  });
  return getDeposit(pool, id);
}

export async function reject(id: string, by: string, reason: string) {
  const { rows: [r] } = await pool.query(
    `UPDATE fiat_deposits SET status = 'rejected', reason = $3, released_by = $2, released_at = now(), updated_at = now()
      WHERE id = $1 AND network = $4 AND status IN ('received','minted','reconciled','review') RETURNING id`,
    [id, by, reason.trim(), fiatNetworkId()]);
  if (!r) {
    const { rows: [x] } = await pool.query('SELECT status FROM fiat_deposits WHERE id = $1 AND network = $2', [id, fiatNetworkId()]);
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

export async function acceptWebhook(providerId: string | undefined, headers: Record<string, unknown>, rawBody: string) {
  if (!rawBody) throw new HttpError(400, 'Se requiere el cuerpo crudo firmado del webhook', 'webhook_body_required');
  try { JSON.parse(rawBody); } catch { throw new HttpError(400, 'El cuerpo del webhook no es JSON válido', 'invalid_webhook_body'); }
  const p = providerId ? getFiatProvider(providerId) : getFiatProvider();
  if (!p) throw new HttpError(503, 'Entrada de fiat apagada', 'fiat_disabled');
  const parsed = p.parseWebhook(headers, rawBody);
  if (!parsed.verified) throw new HttpError(503, 'Webhook no aceptado: configure el secreto de firma del proveedor', 'webhook_not_configured');
  const eventId = String(headers['webhook-id'] ?? '').trim();
  if (!eventId || eventId.length > 200) throw new HttpError(400, 'Identificador de evento del proveedor inválido', 'invalid_webhook_id');
  const payloadSha256 = createHash('sha256').update(rawBody).digest('hex');
  const stored = await tx(async (c) => {
    const { rows: [created] } = await c.query(
      `INSERT INTO fiat_webhook_events (provider, external_event_id, payload_sha256, order_ids, verified)
       VALUES ($1,$2,$3,$4,true) ON CONFLICT (provider, external_event_id) DO NOTHING RETURNING id`,
      [p.name, eventId, payloadSha256, JSON.stringify(parsed.order_ids)]);
    if (created) return { duplicate: false };
    const { rows: [existing] } = await c.query(
      `SELECT payload_sha256 FROM fiat_webhook_events WHERE provider = $1 AND external_event_id = $2 FOR UPDATE`,
      [p.name, eventId]);
    if (existing?.payload_sha256 !== payloadSha256) {
      throw new HttpError(409, 'El proveedor reutilizó un identificador de webhook con otro contenido', 'webhook_id_collision');
    }
    return { duplicate: true };
  });
  kickPoll();
  return { ok: true, verified: true, duplicate: stored.duplicate };
}

/** Un ciclo: refresca el IBAN, sondea órdenes, verifica acuñaciones on-chain y concilia. Idempotente. */
export async function fiatTick(log: Log, force = false) {
  const p = getFiatProvider();
  if (!p) return { skipped: 'fiat apagado' };
  const n = findNet(fiatNetworkId());
  if (!n?.healthy) return { skipped: `red ${fiatNetworkId()} fuera de servicio` };
  if (!force && !kick && Date.now() - lastPoll < config.FIAT_POLL_INTERVAL_MS) return { skipped: 'intervalo' };
  kick = false; lastPoll = Date.now();
  const { rows: accounts } = await pool.query(
    `SELECT * FROM fiat_accounts WHERE provider = $1 AND mode = $2
       AND network = $3 AND ($2 = 'per_client' OR status <> 'closed') ORDER BY created_at, id`, [p.name, config.FIAT_MODE, n.id]);
  if (!accounts.length) return { skipped: 'sin cuentas fiat (alta pendiente en la consola)' };
  const out = { orders: 0, minted: 0, reconciled: 0, review: 0 };
  try {
    await expireIntents();
    const asset = await fiatAsset();
    for (let acc of accounts) {
      if (acc.status !== 'closed') acc = await refreshIban(p, acc);
      for (const o of await p.listOrders(acc.address)) {
        if (o.kind !== 'issue') continue; // esta fase solo entrada
        if (o.address.toLowerCase() !== String(acc.address).toLowerCase()) {
          throw new HttpError(502, `Monerium devolvió la orden ${o.id} para una dirección distinta a la cuenta`, 'provider_account_mismatch');
        }
        out.orders++;
        await upsertOrder(acc, asset.id, n.id, o, log);
      }
      out.minted += await verifyMints(n, acc, asset, log);
    }
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
  const clientId = acc.mode === 'per_client' ? String(acc.client_id) : null;
  const idempotencyKey = fiatIdempotencyKey(acc.provider, o.id, clientId);
  const closedAccount = acc.status === 'closed';
  await pool.query(
    `INSERT INTO fiat_deposits (fiat_account_id, provider, provider_order_id, idempotency_key, amount_cents, token_amount,
        asset_id, reference, payer_iban_masked, payer_name, network, provider_state, provider_payload,
        client_id, status, review_reason, match_rule)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
     ON CONFLICT (fiat_account_id, provider_order_id) DO NOTHING`,
    [acc.id, acc.provider, o.id, idempotencyKey, cents.toString(), (cents * CENT_TO_TOKEN).toString(), assetId, o.memo,
      maskIban(o.payer_iban), o.payer_name, network, o.state, raw, clientId,
      'received', closedAccount ? 'cuenta cerrada localmente; depósito retenido para revisión' : null,
      acc.mode === 'per_client' ? 'account' : null]);
  const { rows: [d] } = await pool.query(
    `SELECT id, status, tx_hash, amount_cents, client_id, fiat_account_id FROM fiat_deposits
      WHERE fiat_account_id = $1 AND provider_order_id = $2`, [acc.id, o.id]);
  if (String(d.fiat_account_id) !== String(acc.id) || (clientId && String(d.client_id) !== clientId)) {
    throw new HttpError(409, 'La orden fiat no coincide con la cuenta y cliente enlazados', 'fiat_ownership_mismatch');
  }
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
  const { rows } = await pool.query(
    `SELECT id, tx_hash, token_amount FROM fiat_deposits
      WHERE status = 'minted' AND network = $1 AND fiat_account_id = $2 ORDER BY received_at`, [n.id, acc.id]);
  if (!rows.length) return 0;
  let done = 0;
  for (const d of rows) {
    const result = await fiatCustody.verifyFiatMint({
      network: n.id, contractAddress: asset.contract_address, destination: acc.address,
      transactionHash: d.tx_hash, amount: BigInt(d.token_amount),
    });
    if (result.reason && result.reason !== 'pending') { await toReview(d.id, result.reason); continue; }
    if (!result.verified || result.blockNumber === null || result.logIndex === null) continue;
    await pool.query('UPDATE fiat_deposits SET confirmations = $2, block_number = $3, log_index = $4, updated_at = now() WHERE id = $1',
      [d.id, result.confirmations, result.blockNumber.toString(), result.logIndex]);
    if (result.confirmations < n.confirmations) continue;
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
  const { rows } = await pool.query(
    `SELECT d.id, d.fiat_account_id, d.provider, d.client_id, d.intent_id, d.reference, d.amount_cents,
            a.mode AS account_mode, a.status AS account_status, a.client_id AS account_client_id
       FROM fiat_deposits d JOIN fiat_accounts a ON a.id = d.fiat_account_id
      WHERE d.status = 'reconciled' AND d.network = $1
        AND (d.client_id IS NULL
          OR (a.mode = 'per_client' AND (a.status = 'closed' OR (d.reference IS NOT NULL AND d.intent_id IS NULL))))
      ORDER BY d.received_at`, [fiatNetworkId()]);
  let reconciled = 0, review = 0;
  for (const d of rows) {
    const verdict = await tx(async (c) => {
      if (d.account_mode === 'per_client') {
        if (String(d.client_id) !== String(d.account_client_id)) return { review: 'la cuenta y el cliente del depósito no coinciden' };
        if (d.account_status === 'closed') return { review: 'depósito recibido después del cierre local de la cuenta; requiere revisión de tesorería' };
        const m = parseMemo(d.reference);
        if (m.reference) {
          if (!m.reference_valid) return { review: `referencia ${m.reference} con dígitos de control inválidos` };
          const { rows: [i] } = await c.query(
            `SELECT * FROM fiat_payment_intents
              WHERE reference = $1 AND client_id = $2 AND fiat_account_id = $3 AND provider = $4 FOR UPDATE`,
            [m.reference, d.client_id, d.fiat_account_id, d.provider]);
          if (!i) return { review: `el aviso ${m.reference} no pertenece a esta cuenta, cliente y proveedor` };
          if (i.status !== 'open') return { review: `aviso ${m.reference} ${INTENT_ES[i.status as string] ?? i.status}` };
          if (new Date(i.expires_at) <= new Date()) return { review: `aviso ${m.reference} vencido` };
          if (BigInt(i.expected_amount) !== BigInt(d.amount_cents)) {
            return { review: `monto ${centsToEur(d.amount_cents)} distinto al del aviso ${m.reference} (${centsToEur(i.expected_amount)})` };
          }
          await c.query(`UPDATE fiat_payment_intents SET status = 'matched', matched_deposit_id = $2, updated_at = now() WHERE id = $1`, [i.id, d.id]);
          await c.query(`UPDATE fiat_deposits SET intent_id = $2, match_rule = 'intent', updated_at = now() WHERE id = $1`, [d.id, i.id]);
          return { client: d.client_id };
        }
        await c.query(`UPDATE fiat_deposits SET match_rule = 'account', updated_at = now() WHERE id = $1`, [d.id]);
        return { client: d.client_id };
      }
      const m = parseMemo(d.reference);
      if (m.reference) {
        if (!m.reference_valid) return { review: `referencia ${m.reference} con dígitos de control inválidos` };
        const { rows: [i] } = await c.query(
          `SELECT * FROM fiat_payment_intents
            WHERE reference = $1 AND fiat_account_id = $2 AND provider = $3 FOR UPDATE`,
          [m.reference, d.fiat_account_id, d.provider]);
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
export async function simulateOrder(b: {
  amount: string; memo?: string; payer_name?: string; payer_iban?: string; tx_hash?: string;
  state?: 'pending' | 'processed' | 'rejected'; client_id?: string;
}) {
  const mock = mockProvider();
  if (!mock) throw new HttpError(403, 'La simulación solo existe con el proveedor simulado (sandbox)', 'simulation_disabled');
  const acc = config.FIAT_MODE === 'per_client'
    ? b.client_id ? await clientAccount(b.client_id) : null
    : await currentAccount();
  if (!acc) throw new HttpError(409, 'Seleccione un cliente con cuenta fiat activa', 'fiat_not_ready');
  const o = mock.simulateOrder({ address: acc.address, amount: b.amount, memo: b.memo, payer_name: b.payer_name, payer_iban: b.payer_iban,
    tx_hash: b.tx_hash, state: b.state });
  kickPoll();
  return { order_id: o.id, state: o.state, address: acc.address, client_id: acc.client_id ?? null, provider: acc.provider };
}

/** Simulación: la misma orden pasa a «processed» con su hash de acuñación. */
export async function simulateProcess(orderId: string, txHash: string, clientId?: string) {
  const mock = mockProvider();
  if (!mock) throw new HttpError(403, 'La simulación solo existe con el proveedor simulado (sandbox)', 'simulation_disabled');
  const acc = config.FIAT_MODE === 'per_client'
    ? clientId ? await clientAccount(clientId) : null
    : await currentAccount();
  if (!acc) throw new HttpError(409, 'Primero dé de alta la cuenta fiat', 'fiat_not_ready');
  const cur = (await mock.listOrders(acc.address)).find((o) => o.id === orderId);
  if (!cur) throw new HttpError(404, 'Orden simulada no encontrada', 'not_found');
  mock.simulateOrder({ ...cur, id: orderId, tx_hash: txHash, state: 'processed' });
  kickPoll();
  return { order_id: orderId, state: 'processed' };
}
