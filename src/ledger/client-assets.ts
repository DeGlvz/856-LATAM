// Activos habilitados por cliente (multi-red, ola 1).
//   enabled   → puede recibir y disponer
//   exit_only → solo puede retirar o compensar lo que tiene; no recibe más (baja ordenada de un activo con saldo)
//   (sin fila) → no habilitado: no opera; un depósito que llegue queda "held" para que tesorería decida
// Lo administra el Tesorero con 2FA; el Ejecutivo solo lo solicita. Es configuración del contrato, no originación.
import { defaultClientNetworks } from '../config.js';
import { csv, findNet, isEnabled, KNOWN, primaryNet } from '../chain/networks.js';
import { pool, tx, type Tx } from '../db.js';

const sweepMinOf = (assetId: string) => process.env[`SWEEP_MIN_${assetId.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`]?.trim() || null;
import { HttpError } from '../idempotency.js';
import { decodeCursor, page } from '../pagination.js';

export type AssetStatus = 'enabled' | 'exit_only';
type Q = Tx | typeof pool;

export async function assetStatus(c: Q, clientId: string, assetId: string): Promise<AssetStatus | null> {
  const { rows: [r] } = await c.query('SELECT status FROM client_assets WHERE client_id = $1 AND asset_id = $2', [clientId, assetId]);
  return (r?.status as AssetStatus) ?? null;
}

/**
 * dir 'in'  → recibir (depósitos, cobrar obligaciones): exige enabled.
 * dir 'out' → disponer (retiros, pagar obligaciones): enabled o exit_only.
 */
export async function assertAssetEnabled(c: Q, clientId: string, assetId: string, dir: 'in' | 'out') {
  const s = await assetStatus(c, clientId, assetId);
  if (!s || (dir === 'in' && s !== 'enabled')) {
    throw new HttpError(403, s === 'exit_only'
      ? `El activo ${assetId} está en «solo salida» para este cliente: no puede recibir más`
      : `El activo ${assetId} no está habilitado para este cliente`, 'asset_not_enabled');
  }
  return s;
}

/** Al crear un cliente: las redes por defecto (DEFAULT_CLIENT_NETWORKS) + los activos pedidos explícitamente. */
export async function enableDefaults(c: Tx, clientId: string, explicit: string[] = [], by = 'alta del cliente') {
  await c.query(
    `INSERT INTO client_assets (client_id, asset_id, status, updated_by)
     SELECT $1, id, 'enabled', $3 FROM assets WHERE active AND (network = ANY($2) OR id = ANY($4))
     ON CONFLICT DO NOTHING`, [clientId, csv(defaultClientNetworks), by, explicit]);
}

/** Vista para la consola: todos los activos activos con su estado para el cliente, saldo y red encendida. */
export async function listClientAssets(clientId: string) {
  const { rows: [cl] } = await pool.query('SELECT 1 FROM clients WHERE id = $1', [clientId]);
  if (!cl) throw new HttpError(404, 'Cliente no encontrado', 'not_found');
  const { rows } = await pool.query(
    `SELECT s.id AS asset_id, s.symbol, s.network, s.kind, s.decimals, ca.status, ca.updated_by, ca.updated_at,
            COALESCE(a.balance, 0)::text AS balance,
            (SELECT r.id FROM client_asset_requests r WHERE r.client_id = $1 AND r.asset_id = s.id AND r.status = 'pending') AS pending_request
       FROM assets s
       LEFT JOIN client_assets ca ON ca.client_id = $1 AND ca.asset_id = s.id
       LEFT JOIN accounts a ON a.client_id = $1 AND a.asset_id = s.id AND a.type = 'liability'
      WHERE s.active ORDER BY s.network, s.kind DESC, s.symbol`, [clientId]);
  return { assets: rows.map((r) => ({ ...r, status: r.status ?? 'disabled', network_enabled: isEnabled(r.network) })) };
}

/** Vista para el portal: solo lo habilitado (o en solo salida), con su red. */
export async function myAssets(clientId: string) {
  const { rows } = await pool.query(
    `SELECT s.id AS asset_id, s.symbol, s.network, s.kind, s.decimals, ca.status
       FROM client_assets ca JOIN assets s ON s.id = ca.asset_id
      WHERE ca.client_id = $1 AND s.active ORDER BY s.network, s.kind DESC, s.symbol`, [clientId]);
  // La red principal primero (es la que se usa cuando no se indica red)
  const out = rows.map((r) => ({ ...r, network_label: findNet(r.network)?.label ?? KNOWN[r.network]?.label ?? r.network,
    network_enabled: isEnabled(r.network), network_primary: r.network === primaryNet.id,
    // Fase M1: depósito mínimo recomendado (umbral de barrido) si está configurado; null = sin mínimo
    sweep_min: sweepMinOf(r.asset_id) }));
  return { assets: out.sort((x, y) => Number(y.network_primary) - Number(x.network_primary)) };
}

async function openOps(c: Q, clientId: string, assetId: string) {
  const { rows: [r] } = await c.query(
    `SELECT (SELECT count(*) FROM withdrawals WHERE client_id = $1 AND asset_id = $2 AND status IN ('reserved','signed','broadcast'))
          + (SELECT count(*) FROM obligations WHERE asset_id = $2 AND (debtor_id = $1 OR creditor_id = $1) AND status IN ('pending_acceptance','open'))
          + (SELECT count(*) FROM deposits WHERE client_id = $1 AND asset_id = $2 AND status IN ('pending','held')) AS n`, [clientId, assetId]);
  return Number(r.n);
}

/** Aplica el cambio (tesorero). 'disabled' solo sin saldo ni operaciones abiertas; si no, use exit_only. */
export async function setClientAsset(clientId: string, assetId: string, status: AssetStatus | 'disabled', by: string, c?: Tx) {
  const run = async (q: Tx) => {
    const { rows: [cl] } = await q.query('SELECT status FROM clients WHERE id = $1 FOR UPDATE', [clientId]);
    if (!cl) throw new HttpError(404, 'Cliente no encontrado', 'not_found');
    const { rows: [a] } = await q.query('SELECT id FROM assets WHERE id = $1 AND active', [assetId]);
    if (!a) throw new HttpError(404, 'Activo no encontrado', 'not_found');
    if (status === 'disabled') {
      const { rows: [acc] } = await q.query(
        `SELECT balance FROM accounts WHERE client_id = $1 AND asset_id = $2 AND type = 'liability'`, [clientId, assetId]);
      if ((acc && BigInt(acc.balance) !== 0n) || (await openOps(q, clientId, assetId)) > 0) {
        throw new HttpError(409, 'El cliente tiene saldo u operaciones abiertas en este activo: póngalo en «solo salida»', 'asset_in_use');
      }
      await q.query('DELETE FROM client_assets WHERE client_id = $1 AND asset_id = $2', [clientId, assetId]);
    } else {
      await q.query(
        `INSERT INTO client_assets (client_id, asset_id, status, updated_by) VALUES ($1,$2,$3,$4)
         ON CONFLICT (client_id, asset_id) DO UPDATE SET status = EXCLUDED.status, updated_by = EXCLUDED.updated_by, updated_at = now()`,
        [clientId, assetId, status, by]);
    }
  };
  if (c) await run(c); else await tx(run);
  return listClientAssets(clientId);
}

// ───── Solicitudes del ejecutivo ─────
const ACTION_TO_STATUS = { enable: 'enabled', exit_only: 'exit_only', disable: 'disabled' } as const;

export async function requestChange(i: { client_id: string; asset_id: string; action: keyof typeof ACTION_TO_STATUS; reason: string; by: string; operatorId: string | null }) {
  const { rows: [a] } = await pool.query('SELECT id FROM assets WHERE id = $1 AND active', [i.asset_id]);
  if (!a) throw new HttpError(404, 'Activo no encontrado', 'not_found');
  const { rows: [cl] } = await pool.query('SELECT 1 FROM clients WHERE id = $1', [i.client_id]);
  if (!cl) throw new HttpError(404, 'Cliente no encontrado', 'not_found');
  try {
    const { rows: [r] } = await pool.query(
      `INSERT INTO client_asset_requests (client_id, asset_id, action, reason, requested_by, requested_by_operator)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`, [i.client_id, i.asset_id, i.action, i.reason.trim(), i.by, i.operatorId]);
    return r;
  } catch (e) {
    if ((e as { code?: string }).code === '23505') throw new HttpError(409, 'Ya hay una solicitud pendiente para ese activo', 'request_pending');
    throw e;
  }
}

export async function listRequests(f: { status?: string; client_id?: string; limit: number; cursor?: string }) {
  const cur = decodeCursor(f.cursor);
  const { rows } = await pool.query(
    `SELECT r.*, r.created_at::text AS _ts, c.name AS client_name, s.symbol, s.network
       FROM client_asset_requests r JOIN clients c ON c.id = r.client_id JOIN assets s ON s.id = r.asset_id
      WHERE ($1::text IS NULL OR r.status = $1) AND ($2::uuid IS NULL OR r.client_id = $2)
        AND ($3::timestamptz IS NULL OR (r.created_at, r.id) < ($3::timestamptz, $4::uuid))
      ORDER BY r.created_at DESC, r.id DESC LIMIT $5`,
    [f.status ?? null, f.client_id ?? null, cur?.[0] ?? null, cur?.[1] ?? null, f.limit + 1]);
  const p = page(rows, f.limit);
  return { requests: p.items.map(({ _ts, ...r }) => r), next_cursor: p.next_cursor };
}

/** Decisión del tesorero (2FA en la ruta). Quien solicitó no decide. */
export async function decideRequest(id: string, approve: boolean, by: { email: string; id: string }, note?: string) {
  return tx(async (c) => {
    const { rows: [r] } = await c.query('SELECT * FROM client_asset_requests WHERE id = $1 FOR UPDATE', [id]);
    if (!r) throw new HttpError(404, 'Solicitud no encontrada', 'not_found');
    if (r.status !== 'pending') throw new HttpError(409, 'La solicitud ya fue resuelta', 'not_pending');
    if (r.requested_by_operator === by.id) throw new HttpError(403, 'Quien solicita no aprueba', 'same_operator');
    if (approve) await setClientAsset(r.client_id, r.asset_id, ACTION_TO_STATUS[r.action as keyof typeof ACTION_TO_STATUS], by.email, c);
    const { rows: [u] } = await c.query(
      `UPDATE client_asset_requests SET status = $2, decided_by = $3, decided_at = now(), decision_note = $4 WHERE id = $1 RETURNING *`,
      [id, approve ? 'approved' : 'rejected', by.email, note ?? null]);
    return u;
  });
}
