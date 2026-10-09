import { pool, tx, type Tx } from '../db.js';

export class LedgerError extends Error {
  constructor(public statusCode: number, message: string, public code = 'ledger_error') { super(message); }
}

type Side = 'debit' | 'credit';
const AMOUNT_RE = /^[1-9]\d{0,77}$/; // entero positivo en unidades base

// ───────────── Activos ─────────────
export interface AssetInput {
  id: string; symbol: string; chain: string; network: string;
  kind: 'native' | 'erc20' | 'trc20' | 'utxo'; contract_address?: string | null; decimals: number;
}

export async function createAsset(a: AssetInput) {
  return tx(async (c) => {
    const { rows } = await c.query(
      `INSERT INTO assets (id, symbol, chain, network, kind, contract_address, decimals)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [a.id, a.symbol, a.chain, a.network, a.kind, a.contract_address?.toLowerCase() ?? null, a.decimals],
    );
    await ensureSystemAccounts(c, a.id);
    return rows[0];
  });
}

export async function listAssets() {
  return (await pool.query('SELECT * FROM assets ORDER BY id')).rows;
}

// Cuentas de la plataforma por activo:
//  custody  (activo)     → lo que la master wallet tiene on-chain
//  fees     (ingreso)    → spread y comisiones
//  equity   (patrimonio) → ajustes/capital; puede quedar negativa
const SYSTEM_ACCOUNTS = [
  ['custody', 'asset', 'debit', false, 'Custodia on-chain (master wallet)'],
  ['fees', 'revenue', 'credit', false, 'Ingresos por comisiones y spread'],
  ['equity', 'equity', 'credit', true, 'Patrimonio / ajustes'],
] as const;

export async function ensureSystemAccounts(c: Tx, assetId: string) {
  for (const [suffix, type, side, neg, name] of SYSTEM_ACCOUNTS) {
    await c.query(
      `INSERT INTO accounts (code, asset_id, type, normal_side, allow_negative, name)
       VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (code) DO NOTHING`,
      [`system:${assetId}:${suffix}`, assetId, type, side, neg, `${name} — ${assetId}`],
    );
  }
}

export async function ensureAllSystemAccounts() {
  await tx(async (c) => {
    const { rows } = await c.query<{ id: string }>('SELECT id FROM assets WHERE active');
    for (const r of rows) await ensureSystemAccounts(c, r.id);
  });
}

// ───────────── Clientes y cuentas ─────────────
export async function createClient(input: {
  name: string; external_id?: string; kind?: string; metadata?: Record<string, unknown>; assets?: string[];
}) {
  return tx(async (c) => {
    const { rows } = await c.query(
      `INSERT INTO clients (name, external_id, kind, metadata) VALUES ($1,$2,COALESCE($3,'corporate'),$4) RETURNING *`,
      [input.name, input.external_id ?? null, input.kind ?? null, input.metadata ?? {}],
    );
    const client = rows[0];
    const accounts = [];
    for (const assetId of input.assets ?? []) accounts.push(await openClientAccount(c, client.id, assetId));
    return { ...client, accounts };
  });
}

export async function getClient(id: string) {
  const { rows } = await pool.query('SELECT * FROM clients WHERE id = $1', [id]);
  if (!rows[0]) throw new LedgerError(404, 'Cliente no encontrado', 'not_found');
  const acc = await pool.query('SELECT * FROM accounts WHERE client_id = $1 ORDER BY asset_id', [id]);
  return { ...rows[0], accounts: acc.rows };
}

// Cuenta "available" del cliente: pasivo (le debemos el saldo), nunca negativa
export async function openClientAccount(c: Tx, clientId: string, assetId: string) {
  const asset = await c.query('SELECT 1 FROM assets WHERE id = $1 AND active', [assetId]);
  if (!asset.rowCount) throw new LedgerError(422, `Activo no soportado: ${assetId}`, 'invalid_asset');
  const code = `client:${clientId}:${assetId}:available`;
  const { rows } = await c.query(
    `INSERT INTO accounts (code, client_id, asset_id, type, normal_side, name)
     VALUES ($1,$2,$3,'liability','credit',$4)
     ON CONFLICT (code) DO UPDATE SET code = EXCLUDED.code RETURNING *`,
    [code, clientId, assetId, `Saldo disponible ${assetId}`],
  );
  return rows[0];
}

export async function openAccountForClient(clientId: string, assetId: string) {
  return tx(async (c) => {
    const cl = await c.query('SELECT 1 FROM clients WHERE id = $1', [clientId]);
    if (!cl.rowCount) throw new LedgerError(404, 'Cliente no encontrado', 'not_found');
    return openClientAccount(c, clientId, assetId);
  });
}

export async function getAccount(ref: string) {
  const byId = /^[0-9a-f-]{36}$/i.test(ref);
  const { rows } = await pool.query(`SELECT * FROM accounts WHERE ${byId ? 'id' : 'code'} = $1`, [ref]);
  if (!rows[0]) throw new LedgerError(404, 'Cuenta no encontrada', 'not_found');
  return rows[0];
}

export async function listPostings(accountId: string, limit = 50, before?: string) {
  const { rows } = await pool.query(
    `SELECT p.id, p.entry_id, p.direction, p.amount, p.balance_after, p.created_at, e.kind, e.external_ref
       FROM postings p JOIN journal_entries e ON e.id = p.entry_id
      WHERE p.account_id = $1 AND ($2::bigint IS NULL OR p.id < $2)
      ORDER BY p.id DESC LIMIT $3`,
    [accountId, before ?? null, Math.min(limit, 500)],
  );
  return { postings: rows, next_before: rows.length ? rows[rows.length - 1].id : null };
}

// ───────────── Wallets on-chain ─────────────
export async function registerWallet(w: {
  client_id?: string | null; chain: string; network: string; address: string;
  purpose: 'master_hot' | 'master_cold' | 'deposit' | 'withdrawal_whitelist';
  custody_ref?: string; derivation_path?: string; label?: string;
}) {
  const address = w.chain === 'ethereum' ? w.address.toLowerCase() : w.address;
  const { rows } = await pool.query(
    `INSERT INTO wallets (client_id, chain, network, address, purpose, custody_ref, derivation_path, label)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
    [w.client_id ?? null, w.chain, w.network, address, w.purpose, w.custody_ref ?? null, w.derivation_path ?? null, w.label ?? null],
  );
  return rows[0];
}

export async function listWallets(filter: { client_id?: string; network?: string }) {
  const { rows } = await pool.query(
    `SELECT * FROM wallets WHERE ($1::uuid IS NULL OR client_id = $1) AND ($2::text IS NULL OR network = $2)
     ORDER BY created_at`,
    [filter.client_id ?? null, filter.network ?? null],
  );
  return rows;
}

// ───────────── Asientos (doble partida) ─────────────
export interface PostingInput { account: string; direction: Side; amount: string }
export interface EntryInput {
  kind: string; description?: string; external_ref?: string; idempotency_key?: string;
  metadata?: Record<string, unknown>; postings: PostingInput[];
}

export async function getEntry(id: string) {
  const e = await pool.query('SELECT * FROM journal_entries WHERE id = $1', [id]);
  if (!e.rows[0]) throw new LedgerError(404, 'Asiento no encontrado', 'not_found');
  const p = await pool.query(
    `SELECT p.id, p.account_id, a.code AS account_code, p.asset_id, p.direction, p.amount, p.balance_after
       FROM postings p JOIN accounts a ON a.id = p.account_id WHERE p.entry_id = $1 ORDER BY p.id`,
    [id],
  );
  return { ...e.rows[0], postings: p.rows };
}

export async function postEntry(input: EntryInput): Promise<{ entry: Awaited<ReturnType<typeof getEntry>>; replayed: boolean }> {
  if (input.postings.length < 2) throw new LedgerError(422, 'Un asiento requiere al menos 2 partidas', 'invalid_entry');
  for (const p of input.postings) {
    if (!AMOUNT_RE.test(p.amount)) throw new LedgerError(422, `Monto inválido: ${p.amount} (entero positivo en unidades base)`, 'invalid_amount');
  }

  try {
    const entryId = await tx(async (c) => {
      if (input.idempotency_key) {
        const prev = await c.query('SELECT id FROM journal_entries WHERE idempotency_key = $1', [input.idempotency_key]);
        if (prev.rows[0]) return { id: prev.rows[0].id as string, replayed: true };
      }

      // Resolver cuentas (por id o code) y bloquearlas en orden fijo para evitar interbloqueos
      const refs = [...new Set(input.postings.map((p) => p.account))];
      const { rows: accs } = await c.query(
        `SELECT id, code, asset_id, normal_side, balance FROM accounts
          WHERE id::text = ANY($1) OR code = ANY($1) ORDER BY id FOR UPDATE`,
        [refs],
      );
      const byRef = new Map<string, (typeof accs)[number]>();
      for (const a of accs) { byRef.set(a.id, a); byRef.set(a.code, a); }
      const missing = refs.filter((r) => !byRef.has(r));
      if (missing.length) throw new LedgerError(404, `Cuenta(s) no encontrada(s): ${missing.join(', ')}`, 'not_found');

      // Cuadre por activo antes de tocar la base (el trigger lo vuelve a validar al COMMIT)
      const net = new Map<string, bigint>();
      for (const p of input.postings) {
        const a = byRef.get(p.account)!;
        const v = BigInt(p.amount) * (p.direction === 'debit' ? 1n : -1n);
        net.set(a.asset_id, (net.get(a.asset_id) ?? 0n) + v);
      }
      for (const [asset, v] of net) if (v !== 0n) throw new LedgerError(422, `Asiento descuadrado en ${asset}: diferencia ${v}`, 'unbalanced');

      const { rows: [entry] } = await c.query(
        `INSERT INTO journal_entries (kind, description, external_ref, idempotency_key, metadata)
         VALUES ($1,$2,$3,$4,$5) RETURNING id`,
        [input.kind, input.description ?? null, input.external_ref ?? null, input.idempotency_key ?? null, input.metadata ?? {}],
      );

      const running = new Map<string, bigint>(accs.map((a) => [a.id, BigInt(a.balance)]));
      for (const p of input.postings) {
        const a = byRef.get(p.account)!;
        const delta = BigInt(p.amount) * (p.direction === a.normal_side ? 1n : -1n);
        const after = running.get(a.id)! + delta;
        running.set(a.id, after);
        await c.query(
          `INSERT INTO postings (entry_id, account_id, asset_id, direction, amount, balance_after)
           VALUES ($1,$2,$3,$4,$5,$6)`,
          [entry.id, a.id, a.asset_id, p.direction, p.amount, after.toString()],
        );
      }
      for (const [id, bal] of running) {
        // El CHECK (allow_negative OR balance >= 0) rechaza sobregiros
        await c.query('UPDATE accounts SET balance = $2, version = version + 1 WHERE id = $1', [id, bal.toString()]);
      }
      return { id: entry.id as string, replayed: false };
    });
    return { entry: await getEntry(entryId.id), replayed: entryId.replayed };
  } catch (e) {
    const err = e as { code?: string; constraint?: string };
    if (err.code === '23514') throw new LedgerError(422, 'Saldo insuficiente', 'insufficient_funds');
    if (err.code === '23505' && input.idempotency_key) {
      // Carrera con otra petición con la misma llave: devolver la que ganó
      const prev = await pool.query('SELECT id FROM journal_entries WHERE idempotency_key = $1', [input.idempotency_key]);
      if (prev.rows[0]) return { entry: await getEntry(prev.rows[0].id), replayed: true };
    }
    throw e;
  }
}

// Atajos de negocio sobre postEntry
export function internalTransfer(i: { from: string; to: string; amount: string; idempotency_key?: string; description?: string; metadata?: Record<string, unknown> }) {
  // Pasivo del emisor baja (débito), pasivo del receptor sube (crédito): sin gas, instantáneo
  return postEntry({
    kind: 'transfer', description: i.description, idempotency_key: i.idempotency_key, metadata: i.metadata,
    postings: [
      { account: i.from, direction: 'debit', amount: i.amount },
      { account: i.to, direction: 'credit', amount: i.amount },
    ],
  });
}

export function creditDeposit(i: { client_account: string; asset_id: string; amount: string; tx_hash: string; idempotency_key?: string }) {
  // Entra cripto a la master wallet: custodia (activo) sube, deuda con el cliente (pasivo) sube
  return postEntry({
    kind: 'deposit', external_ref: i.tx_hash, idempotency_key: i.idempotency_key ?? `deposit:${i.tx_hash}:${i.client_account}`,
    postings: [
      { account: `system:${i.asset_id}:custody`, direction: 'debit', amount: i.amount },
      { account: i.client_account, direction: 'credit', amount: i.amount },
    ],
  });
}
