import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { client } from '../chain.js';
import { getSigner } from '../chain/signer.js';
import { config } from '../config.js';
import { pool } from '../db.js';
import { HttpError } from '../idempotency.js';
import { hotWalletStatus } from '../ledger/transfers.js';

const uuid = z.string().uuid();
const limit = (max: number, def: number) => z.coerce.number().int().min(1).max(max).default(def);
const parse = <S extends z.ZodTypeAny>(s: S, v: unknown): z.infer<S> => {
  const r = s.safeParse(v);
  if (!r.success) throw new HttpError(400, r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '), 'validation_error');
  return r.data;
};

// Cursor opaco para paginación por (created_at, id) descendente; created_at viaja como texto de PostgreSQL (microsegundos exactos)
const encodeCursor = (ts: string, id: string) => Buffer.from(JSON.stringify([ts, id])).toString('base64url');
function decodeCursor(c?: string): [string, string] | null {
  if (!c) return null;
  try {
    const v = JSON.parse(Buffer.from(c, 'base64url').toString());
    if (Array.isArray(v) && typeof v[0] === 'string' && uuid.safeParse(v[1]).success) return [v[0], v[1]];
  } catch { /* cae al error */ }
  throw new HttpError(400, 'Cursor inválido', 'invalid_cursor');
}

const EXPLORERS: Record<string, string> = {
  'eth-mainnet': 'https://etherscan.io', 'eth-sepolia': 'https://sepolia.etherscan.io',
  'base-mainnet': 'https://basescan.org', 'polygon-mainnet': 'https://polygonscan.com', 'arb-mainnet': 'https://arbiscan.io',
};

// La conciliación consulta la cadena por cada dirección de depósito: se cachea unos segundos para no castigar el RPC
let hotCache: { at: number; value: Promise<Awaited<ReturnType<typeof hotWalletStatus>>> } | null = null;
function cachedHotWallet() {
  if (!hotCache || Date.now() - hotCache.at > 10_000) {
    const value = hotWalletStatus();
    hotCache = { at: Date.now(), value };
    value.catch(() => { hotCache = null; });
  }
  return hotCache.value;
}

const settle = async <T>(p: Promise<T>): Promise<{ ok: true; value: T } | { ok: false; error: string }> =>
  p.then((value) => ({ ok: true as const, value }), (e) => ({ ok: false as const, error: (e as Error).message?.slice(0, 200) ?? 'error' }));

export async function consoleRoutes(app: FastifyInstance) {
  // ───────────── Tablero ─────────────
  app.get('/summary', async () => {
    const [chainId, block, db, hot] = await Promise.all([
      settle(client.getChainId()), settle(client.getBlockNumber()),
      settle(pool.query('SELECT 1')), settle(cachedHotWallet()),
    ]);

    const q = async <T>(sql: string, params: unknown[] = []) => (await pool.query(sql, params)).rows as T[];
    const [assets, inflight, byStatus, depPending, sweepsOpen, clients] = db.ok ? await Promise.all([
      q<{ id: string; symbol: string; decimals: number; kind: string; network: string }>(
        'SELECT id, symbol, decimals, kind, network FROM assets WHERE active ORDER BY id'),
      q(`SELECT w.id, w.client_id, c.name AS client_name, w.asset_id, w.amount, w.status, w.to_address, w.tx_hash, w.nonce,
                w.confirmations, w.attempts, w.last_error, w.created_at, w.updated_at
           FROM withdrawals w JOIN clients c ON c.id = w.client_id
          WHERE w.status IN ('reserved','signed','broadcast') ORDER BY w.created_at LIMIT 50`),
      q<{ status: string; n: string }>(
        `SELECT status, count(*) AS n FROM withdrawals WHERE status IN ('reserved','signed','broadcast') GROUP BY status`),
      q<{ n: string }>(`SELECT count(*) AS n FROM deposits WHERE status = 'pending'`),
      q<{ n: string }>(`SELECT count(*) AS n FROM sweeps WHERE status IN ('signed','broadcast')`),
      q<{ status: string; n: string }>('SELECT status, count(*) AS n FROM clients GROUP BY status'),
    ]) : [[], [], [], [{ n: '0' }], [{ n: '0' }], []];

    const h = hot.ok ? hot.value : null;
    const native = assets.find((a) => a.kind === 'native' && a.network === config.ALCHEMY_NETWORK);
    const nativeBal = h && 'balances' in h ? h.balances?.find((b) => b.asset_id === native?.id) : undefined;
    const gasWei = nativeBal && 'hot_wallet' in nativeBal ? nativeBal.hot_wallet ?? null : null;
    const signer = getSigner();

    return {
      generated_at: new Date().toISOString(),
      health: {
        status: db.ok && chainId.ok ? 'ok' : 'degraded',
        db: db.ok ? 'ok' : 'down',
        chain: chainId.ok && block.ok
          ? { status: 'ok', network: config.ALCHEMY_NETWORK, chain_id: chainId.value, block: block.value.toString() }
          : { status: 'down', network: config.ALCHEMY_NETWORK, error: !chainId.ok ? chainId.error : !block.ok ? block.error : null },
        worker_enabled: config.WORKER_ENABLED,
        sweep_enabled: config.SWEEP_ENABLED,
        confirmations: config.CONFIRMATIONS,
        signer: signer?.kind ?? null,
      },
      explorer: EXPLORERS[config.ALCHEMY_NETWORK] ?? null,
      assets,
      reconciliation: h && h.configured
        ? { status: 'ok', address: h.address, deposit_addresses: h.deposit_addresses, balances: h.balances, note: h.note }
        : { status: hot.ok ? 'not_configured' : 'error', error: hot.ok ? 'Sin firmante (SIGNER_PRIVATE_KEY)' : hot.error, balances: [] },
      gas: {
        asset_id: native?.id ?? null, decimals: native?.decimals ?? 18,
        address: h && h.configured ? h.address : null,
        balance_wei: gasWei, threshold_wei: config.GAS_LOW_WEI.toString(),
        low: gasWei == null ? null : BigInt(gasWei) < config.GAS_LOW_WEI,
      },
      withdrawals_in_flight: {
        total: byStatus.reduce((s, r) => s + Number(r.n), 0),
        by_status: Object.fromEntries(byStatus.map((r) => [r.status, Number(r.n)])),
        items: inflight,
      },
      deposits_pending: Number(depPending[0]?.n ?? 0),
      sweeps_open: Number(sweepsOpen[0]?.n ?? 0),
      clients_by_status: Object.fromEntries(clients.map((r) => [r.status, Number(r.n)])),
    };
  });

  // ───────────── Clientes (lista paginada) ─────────────
  const ClientsQuery = z.object({
    limit: limit(200, 50), cursor: z.string().max(300).optional(),
    status: z.enum(['pending_kyb', 'active', 'suspended', 'closed']).optional(),
    kind: z.enum(['corporate', 'fund', 'fintech', 'individual']).optional(),
    q: z.string().trim().min(1).max(100).optional(),
  });
  app.get('/clients', async (req) => {
    const f = parse(ClientsQuery, req.query);
    const cur = decodeCursor(f.cursor);
    const { rows } = await pool.query(
      `SELECT c.id, c.external_id, c.name, c.kind, c.status, c.metadata, c.created_at, c.created_at::text AS _ts,
              (SELECT count(*) FROM accounts a WHERE a.client_id = c.id) AS accounts_count
         FROM clients c
        WHERE ($1::text IS NULL OR c.status = $1)
          AND ($2::text IS NULL OR c.kind = $2)
          AND ($3::text IS NULL OR c.name ILIKE '%' || $3 || '%' OR c.external_id ILIKE '%' || $3 || '%' OR c.id::text = $3)
          AND ($4::timestamptz IS NULL OR (c.created_at, c.id) < ($4::timestamptz, $5::uuid))
        ORDER BY c.created_at DESC, c.id DESC LIMIT $6`,
      [f.status ?? null, f.kind ?? null, f.q?.replace(/[%_\\]/g, '\\$&') ?? null, cur?.[0] ?? null, cur?.[1] ?? null, f.limit + 1]);
    const more = rows.length > f.limit;
    const page = rows.slice(0, f.limit);
    const last = page[page.length - 1];
    return {
      clients: page.map(({ _ts, ...c }) => ({ ...c, accounts_count: Number(c.accounts_count) })),
      next_cursor: more && last ? encodeCursor(last._ts, last.id) : null,
    };
  });

  // ───────────── Asientos (filtros) ─────────────
  const EntriesQuery = z.object({
    limit: limit(200, 50), cursor: z.string().max(300).optional(),
    kind: z.string().max(40).optional(),
    external_ref: z.string().max(200).optional(),
    account: z.string().min(3).max(200).optional(),          // id o code de cuenta
    client_id: uuid.optional(),
    asset_id: z.string().max(40).optional(),
    from: z.string().datetime({ offset: true }).optional(),
    to: z.string().datetime({ offset: true }).optional(),
    postings: z.enum(['true', 'false']).default('true'),
  });
  app.get('/entries', async (req) => {
    const f = parse(EntriesQuery, req.query);
    const cur = decodeCursor(f.cursor);
    const { rows } = await pool.query(
      `SELECT e.id, e.kind, e.description, e.external_ref, e.metadata, e.created_at, e.created_at::text AS _ts,
              CASE WHEN $10 THEN (
                SELECT json_agg(json_build_object('account_id', p.account_id, 'account_code', a.code, 'client_id', a.client_id,
                         'asset_id', p.asset_id, 'direction', p.direction, 'amount', p.amount::text, 'balance_after', p.balance_after::text) ORDER BY p.id)
                  FROM postings p JOIN accounts a ON a.id = p.account_id WHERE p.entry_id = e.id) END AS postings
         FROM journal_entries e
        WHERE ($1::text IS NULL OR e.kind = $1)
          AND ($2::text IS NULL OR e.external_ref = $2)
          AND ($3::text IS NULL OR EXISTS (SELECT 1 FROM postings p JOIN accounts a ON a.id = p.account_id
                                            WHERE p.entry_id = e.id AND (a.id::text = $3 OR a.code = $3)))
          AND ($4::uuid IS NULL OR EXISTS (SELECT 1 FROM postings p JOIN accounts a ON a.id = p.account_id
                                            WHERE p.entry_id = e.id AND a.client_id = $4))
          AND ($5::text IS NULL OR EXISTS (SELECT 1 FROM postings p WHERE p.entry_id = e.id AND p.asset_id = $5))
          AND ($6::timestamptz IS NULL OR e.created_at >= $6)
          AND ($7::timestamptz IS NULL OR e.created_at < $7)
          AND ($8::timestamptz IS NULL OR (e.created_at, e.id) < ($8::timestamptz, $9::uuid))
        ORDER BY e.created_at DESC, e.id DESC LIMIT $11`,
      [f.kind ?? null, f.external_ref ?? null, f.account ?? null, f.client_id ?? null, f.asset_id ?? null,
        f.from ?? null, f.to ?? null, cur?.[0] ?? null, cur?.[1] ?? null, f.postings === 'true', f.limit + 1]);
    const more = rows.length > f.limit;
    const page = rows.slice(0, f.limit);
    const last = page[page.length - 1];
    return {
      entries: page.map(({ _ts, postings, ...e }) => (f.postings === 'true' ? { ...e, postings: postings ?? [] } : e)),
      next_cursor: more && last ? encodeCursor(last._ts, last.id) : null,
    };
  });
}
