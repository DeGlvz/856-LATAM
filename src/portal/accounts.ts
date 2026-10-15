// Portal de clientes — fase 2: saldos, movimientos, estado de cuenta, direcciones de depósito, depósitos y avisos.
// Aislamiento: toda consulta recibe el clientId de req.portal (sesión o llave), nunca de la petición.
// Nunca se exponen cuentas system:*, la hot wallet, descripciones/metadata de asientos ni datos de otros clientes:
// el concepto de cada movimiento se arma con el tipo de asiento + referencias que pertenecen al propio cliente.
import { config } from '../config.js';
import { pool, type Tx } from '../db.js';
import { HttpError } from '../idempotency.js';
import { decodeCursor, page } from '../pagination.js';
import { getOrCreateDepositAddress } from '../ledger/deposit-addresses.js';
import { obligationNotices } from './obligations.js';

const IN_FLIGHT = ['reserved', 'signed', 'broadcast']; // retiros aún no finales
const TX_HASH_RE = /^0x[0-9a-f]{64}$/;
const DAY = 86_400_000;

// ───────────── Montos ─────────────
/** Unidades base → texto decimal exacto con todos los decimales del activo (sin flotantes). */
export function toHuman(v: string | bigint, decimals: number) {
  let n = BigInt(v);
  const neg = n < 0n;
  if (neg) n = -n;
  const s = n.toString().padStart(decimals + 1, '0');
  const int = decimals ? s.slice(0, -decimals) : s;
  return `${neg ? '-' : ''}${int}${decimals ? `.${s.slice(-decimals)}` : ''}`;
}

// ───────────── Cuentas del cliente ─────────────
type AccountRow = { id: string; asset_id: string; balance: string; symbol: string; decimals: number; network: string };

async function clientAccounts(c: Tx | typeof pool, clientId: string, assetId?: string): Promise<AccountRow[]> {
  const { rows } = await c.query(
    `SELECT a.id, a.asset_id, a.balance, s.symbol, s.decimals, s.network
       FROM accounts a JOIN assets s ON s.id = a.asset_id
      WHERE a.client_id = $1 AND a.code = 'client:' || $1 || ':' || a.asset_id || ':available'
        AND ($2::text IS NULL OR a.asset_id = $2)
      ORDER BY a.asset_id`, [clientId, assetId ?? null]);
  return rows;
}

/** Cuenta available propia en ese activo; si no la tiene → 404 (igual que un activo inexistente o ajeno). */
async function ownAccount(c: Tx | typeof pool, clientId: string, assetId: string) {
  const [a] = await clientAccounts(c, clientId, assetId);
  if (!a) throw new HttpError(404, 'Cuenta no encontrada', 'not_found');
  return a;
}

/** Lectura consistente (un solo snapshot) para que saldos, totales y renglones cuadren entre sí. */
async function snapshot<T>(fn: (c: Tx) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const r = await fn(c);
    await c.query('COMMIT');
    return r;
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {});
    throw e;
  } finally { c.release(); }
}

// ═════════════ 1. Saldos ═════════════
export async function balances(clientId: string) {
  return snapshot(async (c) => {
    const { rows } = await c.query(
      `WITH acc AS (
         SELECT a.asset_id, a.balance FROM accounts a
          WHERE a.client_id = $1 AND a.code = 'client:' || $1 || ':' || a.asset_id || ':available'),
       res AS (
         SELECT asset_id, sum(amount) AS v FROM withdrawals WHERE client_id = $1 AND status = ANY($2) GROUP BY asset_id),
       pay AS (
         SELECT asset_id, sum(amount) AS v FROM obligations WHERE debtor_id = $1 AND status = 'open' GROUP BY asset_id),
       rec AS (
         SELECT asset_id, sum(amount) AS v FROM obligations WHERE creditor_id = $1 AND status = 'open' GROUP BY asset_id),
       ids AS (SELECT asset_id FROM acc UNION SELECT asset_id FROM res UNION SELECT asset_id FROM pay UNION SELECT asset_id FROM rec)
       SELECT s.id AS asset_id, s.symbol, s.decimals, s.network,
              COALESCE(acc.balance, 0) AS available, COALESCE(res.v, 0) AS reserved,
              COALESCE(pay.v, 0) AS payable, COALESCE(rec.v, 0) AS receivable
         FROM ids JOIN assets s ON s.id = ids.asset_id
         LEFT JOIN acc ON acc.asset_id = s.id LEFT JOIN res ON res.asset_id = s.id
         LEFT JOIN pay ON pay.asset_id = s.id LEFT JOIN rec ON rec.asset_id = s.id
        ORDER BY s.id`, [clientId, IN_FLIGHT]);
    const { rows: [{ now }] } = await c.query('SELECT now() AS now');
    return {
      as_of: now,
      balances: rows.map((r) => ({
        asset_id: r.asset_id, symbol: r.symbol, decimals: r.decimals, network: r.network,
        available: String(r.available), reserved: String(r.reserved), payable: String(r.payable), receivable: String(r.receivable),
        total: (BigInt(r.available) + BigInt(r.reserved)).toString(),
      })),
    };
  });
}

// ═════════════ 2–4. Movimientos ═════════════
// Un renglón por asiento y cuenta del cliente (neto de sus partidas en esa cuenta), sin descripciones internas.
const KIND_ES: Record<string, string> = {
  deposit: 'Depósito', withdrawal: 'Retiro', transfer: 'Transferencia', fee: 'Comisión',
  conversion: 'Conversión', netting: 'Compensación', adjustment: 'Ajuste',
};

type RawLine = {
  id: string; created_at: Date; _ts: string; kind: string; asset_id: string; net: string; balance_after: string;
  external_ref: string | null; dep_tx: string | null; wd_id: string | null; run_id: string | null;
};

function label(kind: string, credit: boolean, l: RawLine) {
  switch (kind) {
    case 'deposit': return credit ? (l.dep_tx ? 'Depósito on-chain acreditado' : 'Depósito acreditado') : 'Reverso de depósito';
    case 'withdrawal': return credit ? 'Reverso de retiro (saldo devuelto)' : 'Retiro (saldo reservado para envío)';
    case 'transfer': return credit ? 'Transferencia recibida' : 'Transferencia enviada';
    case 'netting': return credit ? 'Compensación: cobro neto' : 'Compensación: pago neto';
    case 'fee': return credit ? 'Devolución de comisión' : 'Comisión';
    case 'conversion': return credit ? 'Conversión: entrada' : 'Conversión: salida';
    case 'adjustment': return credit ? 'Ajuste a favor' : 'Ajuste en contra';
    default: return credit ? 'Abono' : 'Cargo';
  }
}

function shape(l: RawLine) {
  const net = BigInt(l.net);
  const credit = net > 0n;
  // Referencias solo propias: retiro del cliente, corrida donde participó, hash de su depósito
  const ref = l.wd_id ? { reference: l.wd_id, reference_type: 'withdrawal' }
    : l.run_id ? { reference: l.run_id, reference_type: 'netting_run' }
      : l.dep_tx ? { reference: l.dep_tx, reference_type: 'tx_hash' }
        : l.external_ref && TX_HASH_RE.test(l.external_ref) ? { reference: l.external_ref, reference_type: 'tx_hash' }
          : { reference: null, reference_type: null };
  return {
    id: l.id, created_at: l.created_at, asset_id: l.asset_id, kind: l.kind,
    direction: credit ? 'credit' : 'debit', amount: (credit ? net : -net).toString(), balance_after: String(l.balance_after),
    ...ref, label: label(l.kind, credit, l),
  };
}
export type Line = ReturnType<typeof shape>;

async function lines(c: Tx | typeof pool, f: {
  clientId: string; accountIds: string[]; from?: string; to?: string; cursor?: string; limit: number; asc?: boolean;
}) {
  const cur = decodeCursor(f.cursor);
  const dir = f.asc ? 'ASC' : 'DESC';
  const { rows } = await c.query<RawLine>(
    `WITH l AS (
       SELECT e.id, e.created_at, e.created_at::text AS _ts, e.kind, p.asset_id,
              sum(CASE p.direction WHEN 'credit' THEN p.amount ELSE -p.amount END) AS net,
              (array_agg(p.balance_after ORDER BY p.id DESC))[1] AS balance_after,
              e.external_ref, e.metadata->>'deposit_id' AS m_dep, e.metadata->>'withdrawal_id' AS m_wd,
              e.metadata->>'netting_run_id' AS m_run
         FROM postings p JOIN journal_entries e ON e.id = p.entry_id
        WHERE p.account_id = ANY($2::uuid[])
          AND ($3::timestamptz IS NULL OR e.created_at >= $3) AND ($4::timestamptz IS NULL OR e.created_at < $4)
          AND ($5::timestamptz IS NULL OR (e.created_at, e.id) ${f.asc ? '>' : '<'} ($5::timestamptz, $6::uuid))
        GROUP BY e.id, p.account_id, p.asset_id
       HAVING sum(CASE p.direction WHEN 'credit' THEN p.amount ELSE -p.amount END) <> 0
        ORDER BY e.created_at ${dir}, e.id ${dir}, p.asset_id LIMIT $7)
     SELECT l.id, l.created_at, l._ts, l.kind, l.asset_id, l.net, l.balance_after, l.external_ref,
            d.tx_hash AS dep_tx, w.id AS wd_id, np.run_id
       FROM l
       LEFT JOIN deposits d ON d.id::text = l.m_dep AND d.client_id = $1
       LEFT JOIN withdrawals w ON w.id::text = l.m_wd AND w.client_id = $1
       LEFT JOIN netting_positions np ON np.run_id::text = l.m_run AND np.client_id = $1
      ORDER BY l.created_at ${dir}, l.id ${dir}, l.asset_id`,
    [f.clientId, f.accountIds, f.from ?? null, f.to ?? null, cur?.[0] ?? null, cur?.[1] ?? null, f.limit + 1]);
  const p = page(rows, f.limit);
  return { items: (p.items as unknown as RawLine[]).map(shape), next_cursor: p.next_cursor };
}

const assetView = (a: AccountRow) => ({ asset_id: a.asset_id, symbol: a.symbol, decimals: a.decimals, network: a.network });

/** Movimientos recientes de todas sus cuentas */
export async function activity(clientId: string, limit: number) {
  const accs = await clientAccounts(pool, clientId);
  if (!accs.length) return { items: [] };
  const byAsset = new Map(accs.map((a) => [a.asset_id, a]));
  const r = await lines(pool, { clientId, accountIds: accs.map((a) => a.id), limit });
  return { items: r.items.map((l) => ({ ...l, symbol: byAsset.get(l.asset_id)!.symbol, decimals: byAsset.get(l.asset_id)!.decimals })) };
}

export interface EntryFilter { asset: string; from?: string; to?: string; cursor?: string; limit: number }

/** Historial paginado de su cuenta available en un activo */
export async function accountEntries(clientId: string, f: EntryFilter) {
  const acc = await ownAccount(pool, clientId, f.asset);
  const r = await lines(pool, { clientId, accountIds: [acc.id], from: f.from, to: f.to, cursor: f.cursor, limit: f.limit });
  return { asset: assetView(acc), balance: acc.balance, entries: r.items, next_cursor: r.next_cursor };
}

// ───────────── CSV ─────────────
const CSV_MAX = 50_000;
const BOM = '﻿';
const cell = (v: unknown) => {
  const s = v == null ? '' : String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const row = (cells: unknown[]) => cells.map(cell).join(',');
const fecha = (d: Date) => new Date(d).toISOString().replace('T', ' ').slice(0, 19);
const HEAD = ['Fecha (UTC)', 'Concepto', 'Tipo', 'Cargo', 'Abono', 'Saldo', 'Referencia', 'Id de movimiento'];
const csvLine = (l: Line, decimals: number) => row([
  fecha(l.created_at), l.label, KIND_ES[l.kind] ?? l.kind,
  l.direction === 'debit' ? toHuman(l.amount, decimals) : '', l.direction === 'credit' ? toHuman(l.amount, decimals) : '',
  toHuman(l.balance_after, decimals), l.reference ?? '', l.id,
]);

async function allLines(c: Tx | typeof pool, clientId: string, accountId: string, from?: string, to?: string) {
  const r = await lines(c, { clientId, accountIds: [accountId], from, to, limit: CSV_MAX, asc: true });
  if (r.next_cursor) throw new HttpError(422, `Demasiados movimientos para un solo archivo (máx. ${CSV_MAX}); acote con from/to`, 'too_many_rows');
  return r.items;
}

/** CSV del historial (orden cronológico ascendente), montos en unidades del activo con todos sus decimales */
export async function accountEntriesCsv(clientId: string, f: Omit<EntryFilter, 'cursor' | 'limit'>) {
  const acc = await ownAccount(pool, clientId, f.asset);
  const items = await allLines(pool, clientId, acc.id, f.from, f.to);
  const body = [row(HEAD), ...items.map((l) => csvLine(l, acc.decimals))].join('\r\n');
  return { filename: `movimientos-${acc.asset_id}.csv`, csv: `${BOM}${body}\r\n` };
}

// ═════════════ Estado de cuenta mensual ═════════════
export async function statement(clientId: string, period: string, assetId: string) {
  const m = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(period);
  if (!m) throw new HttpError(400, 'Periodo inválido (AAAA-MM)', 'validation_error');
  const y = Number(m[1]), mo = Number(m[2]);
  if (y < 2000 || y > 2100) throw new HttpError(400, 'Periodo fuera de rango', 'validation_error');
  const start = new Date(Date.UTC(y, mo - 1, 1)).toISOString();
  const end = new Date(Date.UTC(y, mo, 1)).toISOString();
  return snapshot(async (c) => {
    const acc = await ownAccount(c, clientId, assetId);
    // Saldo inicial/final hacia atrás desde el saldo vigente: cuadra con el saldo actual por construcción
    const { rows: [t] } = await c.query(
      `SELECT COALESCE(sum(net), 0) AS since_start,
              COALESCE(sum(net) FILTER (WHERE created_at >= $3), 0) AS since_end,
              COALESCE(sum(net) FILTER (WHERE created_at < $3 AND net > 0), 0) AS credits,
              COALESCE(-sum(net) FILTER (WHERE created_at < $3 AND net < 0), 0) AS debits
         FROM (SELECT e.created_at, sum(CASE p.direction WHEN 'credit' THEN p.amount ELSE -p.amount END) AS net
                 FROM postings p JOIN journal_entries e ON e.id = p.entry_id
                WHERE p.account_id = $1 AND e.created_at >= $2
                GROUP BY e.id, e.created_at) x`, [acc.id, start, end]);
    const balance = BigInt(acc.balance);
    const opening = balance - BigInt(t.since_start);
    const closing = balance - BigInt(t.since_end);
    const entries = await allLines(c, clientId, acc.id, start, end);
    return {
      asset: assetView(acc), period, timezone: 'UTC', period_start: start, period_end: end,
      opening_balance: opening.toString(), credits: String(t.credits), debits: String(t.debits),
      closing_balance: closing.toString(), current_balance: acc.balance, entries,
    };
  });
}

export async function statementCsv(clientId: string, period: string, assetId: string) {
  const s = await statement(clientId, period, assetId);
  const d = s.asset.decimals;
  const body = [
    row(['Estado de cuenta', `${s.asset.symbol} (${s.asset.asset_id})`]),
    row(['Periodo', `${s.period} (UTC)`]),
    row(['Saldo inicial', toHuman(s.opening_balance, d)]),
    row(['Abonos', toHuman(s.credits, d)]),
    row(['Cargos', toHuman(s.debits, d)]),
    row(['Saldo final', toHuman(s.closing_balance, d)]),
    '',
    row(HEAD), ...s.entries.map((l) => csvLine(l, d)),
  ].join('\r\n');
  return { filename: `estado-de-cuenta-${s.asset.asset_id}-${s.period}.csv`, csv: `${BOM}${body}\r\n` };
}

// ═════════════ 5. Direcciones de depósito ═════════════
const depositView = (w: { id: string; address: string; network: string; derivation_index: number | null; created_at: Date; active: boolean }) => ({
  id: w.id, address: w.address, network: w.network, derivation_index: w.derivation_index, created_at: w.created_at, active: w.active,
  uri: `ethereum:${w.address}`,
});

export async function listDepositAddresses(clientId: string) {
  const { rows } = await pool.query(
    `SELECT id, address, network, derivation_index, created_at, active FROM wallets
      WHERE client_id = $1 AND purpose = 'deposit' ORDER BY created_at DESC, id DESC`, [clientId]);
  return { addresses: rows.map(depositView) };
}

/** Genera una dirección nueva (rotar = generar otra; las anteriores siguen acreditando). Reutiliza la lógica de la consola. */
export async function createDepositAddress(clientId: string, network?: string) {
  if (network && network !== config.ALCHEMY_NETWORK) {
    throw new HttpError(422, `Red no soportada para depósitos: ${network} (disponible: ${config.ALCHEMY_NETWORK})`, 'network_not_supported');
  }
  const r = await getOrCreateDepositAddress(clientId, true);
  const { rows: [w] } = await pool.query(
    `SELECT id, address, network, derivation_index, created_at, active FROM wallets WHERE id = $1 AND client_id = $2`, [r.wallet_id, clientId]);
  return depositView(w);
}

// ═════════════ 6. Depósitos ═════════════
export async function listDeposits(clientId: string, f: { status?: string; limit: number; cursor?: string }) {
  const cur = decodeCursor(f.cursor);
  const { rows } = await pool.query(
    `SELECT d.id, d.tx_hash, d.log_index, d.asset_id, s.symbol, s.decimals, d.amount, d.from_address, w.address AS to_address,
            d.status, d.confirmations, d.block_number, d.created_at, d.credited_at, d.created_at::text AS _ts
       FROM deposits d JOIN wallets w ON w.id = d.wallet_id JOIN assets s ON s.id = d.asset_id
      WHERE d.client_id = $1 AND ($2::text IS NULL OR d.status = $2)
        AND ($3::timestamptz IS NULL OR (d.created_at, d.id) < ($3::timestamptz, $4::uuid))
      ORDER BY d.created_at DESC, d.id DESC LIMIT $5`,
    [clientId, f.status ?? null, cur?.[0] ?? null, cur?.[1] ?? null, f.limit + 1]);
  const p = page(rows, f.limit);
  return {
    deposits: p.items.map((d) => ({ ...d, required_confirmations: config.CONFIRMATIONS })),
    next_cursor: p.next_cursor,
  };
}

// ═════════════ 7. Avisos ═════════════
export interface Notice { code: string; severity: 'info' | 'warning' | 'critical'; message: string; data?: Record<string, unknown> }

export async function notices(clientId: string, user?: { totp_enabled: boolean }) {
  const out: Notice[] = [];
  const { rows: [cl] } = await pool.query('SELECT status FROM clients WHERE id = $1', [clientId]);
  if (cl?.status === 'pending_kyb') {
    out.push({ code: 'kyb_pending', severity: 'warning', message: 'Su expediente KYB está en revisión: podrá retirar cuando 856 lo apruebe', data: { status: cl.status } });
  } else if (cl?.status === 'suspended') {
    out.push({ code: 'client_suspended', severity: 'critical', message: 'Su cuenta está suspendida: puede recibir depósitos pero no disponer de saldo. Contacte a 856', data: { status: cl.status } });
  }
  const { rows: keys } = await pool.query(
    `SELECT prefix, name, expires_at FROM client_api_keys
      WHERE client_id = $1 AND revoked_at IS NULL AND expires_at > now() AND expires_at <= now() + make_interval(days => 14)
      ORDER BY expires_at`, [clientId]);
  for (const k of keys) {
    const days = Math.max(0, Math.ceil((new Date(k.expires_at).getTime() - Date.now()) / DAY));
    out.push({ code: 'api_key_expiring', severity: days <= 3 ? 'critical' : 'warning',
      message: `La llave de API «${k.name}» (${k.prefix}) vence en ${days} día(s): rótela`, data: { prefix: k.prefix, name: k.name, expires_at: k.expires_at, days_left: days } });
  }
  const { rows: [a] } = await pool.query(`SELECT count(*)::int AS n FROM client_users WHERE client_id = $1 AND role = 'admin' AND active`, [clientId]);
  if (a.n < 2) {
    out.push({ code: 'admins_below_minimum', severity: 'warning',
      message: 'Tenga al menos 2 administradores activos: si uno pierde su 2FA, otro puede restablecerlo (recuperación nivel 2)', data: { admins: a.n, required: 2 } });
  }
  if (user && !user.totp_enabled) {
    out.push({ code: 'totp_disabled', severity: 'warning', message: 'Active la verificación en dos pasos (2FA) en su usuario' });
  }
  out.push(...(await obligationNotices(clientId)));
  return { notices: out };
}
