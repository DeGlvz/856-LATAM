// Portal de clientes — fase 3: lista blanca y salidas.
// El cliente ORIGINA (usuario operator+ o llave Ed25519 con permiso withdraw); la tesorería de 856 VALIDA y AUTORIZA en la consola.
// Todo se filtra por el client_id de la sesión o la llave; un recurso de otro cliente responde 404.
import { encodeFunctionData, erc20Abi, isAddress, type Address } from 'viem';
import { client as chain } from '../chain.js';
import { getSigner } from '../chain/signer.js';
import { config } from '../config.js';
import { pool, tx, type Tx } from '../db.js';
import { HttpError } from '../idempotency.js';
import { openClientAccount } from '../ledger/service.js';
import { assertScopeUnchanged, cancelWithdrawal, exitScopeHash, requestWithdrawal } from '../ledger/transfers.js';
import { roleAtLeast, type ClientUser, type PortalPrincipal } from './identity.js';

const lower = (a: string) => a.toLowerCase();
const NOT_FOUND = (what: string) => new HttpError(404, `${what} no encontrado`, 'not_found');

// ═════════════ Lista blanca ═════════════
const wlView = (w: Record<string, unknown>) => {
  const activeFrom = w.active_from ? new Date(w.active_from as string) : null;
  const state = w.wl_status === 'active'
    ? (activeFrom && activeFrom > new Date() ? 'cooling' : 'active')
    : w.wl_status as string; // pending_approval | removed
  return {
    id: w.id, address: w.address, network: w.network, label: w.label, state,
    requested_at: w.wl_requested_at ?? w.created_at, approved_at: w.wl_approved_at, active_from: w.active_from,
    removed_at: w.removed_at, requested_by_me: false as boolean,
  };
};

export async function listWhitelist(clientId: string, me?: string) {
  const { rows } = await pool.query(
    `SELECT * FROM wallets WHERE client_id = $1 AND purpose = 'withdrawal_whitelist'
      ORDER BY (wl_status = 'removed'), created_at DESC`, [clientId]);
  return { cooldown_hours: config.WHITELIST_COOLDOWN_HOURS,
    entries: rows.map((w) => ({ ...wlView(w), requested_by_me: !!me && w.wl_requested_by === me })) };
}

/** Solicitud de alta: la hace un usuario operator+; queda pendiente de que la apruebe OTRO usuario approver+. */
export async function requestWhitelist(u: ClientUser, b: { address: string; label?: string }) {
  if (!roleAtLeast(u.role, 'operator')) throw new HttpError(403, 'Requiere rol operator', 'forbidden');
  if (!isAddress(b.address)) throw new HttpError(400, 'Dirección inválida', 'invalid_address');
  const address = lower(b.address);
  const network = config.ALCHEMY_NETWORK;
  return tx(async (c) => {
    const { rows: [cl] } = await c.query('SELECT status FROM clients WHERE id = $1', [u.client_id]);
    if (cl.status === 'closed') throw new HttpError(409, 'Cliente cerrado', 'client_closed');
    const { rows: [ex] } = await c.query('SELECT * FROM wallets WHERE network = $1 AND address = $2 FOR UPDATE', [network, address]);
    if (ex && ex.client_id === u.client_id && ex.purpose === 'withdrawal_whitelist') {
      if (ex.wl_status !== 'removed') throw new HttpError(409, 'Esa dirección ya está en su lista blanca o por aprobar', 'already_listed');
      const { rows: [w] } = await c.query(
        `UPDATE wallets SET wl_status = 'pending_approval', active = false, wl_requested_by = $2, wl_requested_at = now(),
                wl_approved_by = NULL, wl_approved_at = NULL, active_from = NULL, removed_at = NULL, removed_by = NULL,
                label = COALESCE($3, label) WHERE id = $1 RETURNING *`, [ex.id, u.id, b.label ?? null]);
      return wlView(w);
    }
    // Otra wallet de 856 o de otro cliente: no se revela de quién es
    if (ex) throw new HttpError(409, 'Esa dirección no se puede registrar', 'address_unavailable');
    const { rows: [w] } = await c.query(
      `INSERT INTO wallets (client_id, chain, network, address, purpose, label, active, wl_status, wl_requested_by, wl_requested_at)
       VALUES ($1,'ethereum',$2,$3,'withdrawal_whitelist',$4,false,'pending_approval',$5,now()) RETURNING *`,
      [u.client_id, network, address, b.label ?? null, u.id]);
    return wlView(w);
  });
}

/** Aprobación (approver+, distinto de quien la pidió; el 2FA se verifica en la ruta). Empieza la espera. */
export async function approveWhitelist(u: ClientUser, id: string) {
  if (!roleAtLeast(u.role, 'approver')) throw new HttpError(403, 'Requiere rol approver', 'forbidden');
  return tx(async (c) => {
    const { rows: [w] } = await c.query(
      `SELECT * FROM wallets WHERE id = $1 AND client_id = $2 AND purpose = 'withdrawal_whitelist' FOR UPDATE`, [id, u.client_id]);
    if (!w) throw NOT_FOUND('Dirección');
    if (w.wl_status !== 'pending_approval') throw new HttpError(409, 'La dirección no está pendiente de aprobación', 'not_pending');
    if (w.wl_requested_by === u.id) throw new HttpError(403, 'Quien solicitó la dirección no puede aprobarla', 'same_user');
    const { rows: [r] } = await c.query(
      `UPDATE wallets SET wl_status = 'active', active = true, wl_approved_by = $2, wl_approved_at = now(),
              active_from = now() + make_interval(secs => $3) WHERE id = $1 RETURNING *`,
      [id, u.id, Math.round(config.WHITELIST_COOLDOWN_HOURS * 3600)]);
    return wlView(r);
  });
}

/** Baja inmediata (approver+). Las salidas pendientes hacia esa dirección fallarán su validación (scope_changed). */
export async function removeWhitelist(u: ClientUser, id: string) {
  if (!roleAtLeast(u.role, 'approver')) throw new HttpError(403, 'Requiere rol approver', 'forbidden');
  const { rows: [w] } = await pool.query(
    `UPDATE wallets SET wl_status = 'removed', active = false, removed_at = now(), removed_by = $3
      WHERE id = $1 AND client_id = $2 AND purpose = 'withdrawal_whitelist' AND wl_status <> 'removed' RETURNING *`,
    [id, u.client_id, `portal:${u.email}`]);
  if (!w) throw NOT_FOUND('Dirección');
  return wlView(w);
}

// ═════════════ Umbral de aprobación interna del cliente ═════════════
export async function listThresholds(clientId: string) {
  const { rows } = await pool.query(
    `SELECT t.asset_id, s.symbol, s.decimals, t.threshold::text AS threshold, t.updated_at
       FROM client_approval_thresholds t JOIN assets s ON s.id = t.asset_id WHERE t.client_id = $1 ORDER BY t.asset_id`, [clientId]);
  return { thresholds: rows };
}

export async function setThreshold(u: ClientUser, assetId: string, threshold: string | null) {
  const { rows: [a] } = await pool.query('SELECT id FROM assets WHERE id = $1 AND active', [assetId]);
  if (!a) throw NOT_FOUND('Activo');
  if (threshold === null) {
    await pool.query('DELETE FROM client_approval_thresholds WHERE client_id = $1 AND asset_id = $2', [u.client_id, assetId]);
  } else {
    await pool.query(
      `INSERT INTO client_approval_thresholds (client_id, asset_id, threshold, updated_by) VALUES ($1,$2,$3,$4)
       ON CONFLICT (client_id, asset_id) DO UPDATE SET threshold = EXCLUDED.threshold, updated_by = EXCLUDED.updated_by, updated_at = now()`,
      [u.client_id, assetId, threshold, u.id]);
  }
  return listThresholds(u.client_id);
}

// ═════════════ Simulación ═════════════
type Origin = { kind: 'client_user' | 'client_key'; ref: string; userId?: string };

/** Quién origina: usuario operator+ o llave Ed25519 con permiso withdraw (la ruta ya validó el permiso de la llave). */
export function originOf(p: PortalPrincipal): Origin {
  if (p.kind === 'client_user') {
    if (!roleAtLeast(p.user.role, 'operator')) throw new HttpError(403, 'Requiere rol operator para originar salidas', 'forbidden');
    return { kind: 'client_user', ref: p.user.id, userId: p.user.id };
  }
  if (p.key.kind !== 'ed25519' || !p.key.permissions.includes('withdraw')) {
    throw new HttpError(403, 'La llave no tiene permiso withdraw', 'forbidden');
  }
  return { kind: 'client_key', ref: p.key.prefix };
}

async function estimateGas(asset: { kind: string; contract_address: string | null }, to: string, amount: bigint) {
  try {
    const s = getSigner();
    if (!s) return null;
    const call = asset.kind === 'native'
      ? { to: to as Address, value: amount }
      : { to: asset.contract_address as Address, data: encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [to as Address, amount] }) };
    const [gas, fees] = await Promise.all([chain.estimateGas({ account: s.address() as Address, ...call }), chain.estimateFeesPerGas()]);
    return ((gas * 12n) / 10n * fees.maxFeePerGas).toString();
  } catch { return null; } // informativo: el gas lo paga 856
}

async function payableOf(c: Tx | typeof pool, clientId: string, assetId: string) {
  const { rows } = await c.query(
    `SELECT id, amount::text AS amount, due_at, external_ref FROM obligations
      WHERE debtor_id = $1 AND asset_id = $2 AND status = 'open' ORDER BY created_at`, [clientId, assetId]);
  const total = rows.reduce((s, r) => s + BigInt(r.amount), 0n);
  return { total, items: rows };
}

export async function simulate(p: PortalPrincipal, b: { asset_id: string; whitelist_id: string; amount: string }) {
  const origin = originOf(p);
  const clientId = p.clientId;
  const { rows: [cl] } = await pool.query('SELECT status FROM clients WHERE id = $1', [clientId]);
  if (cl.status !== 'active') throw new HttpError(422, 'Su cuenta no está activa (KYB pendiente o suspendida): no puede retirar', 'client_not_active');
  const { rows: [asset] } = await pool.query('SELECT * FROM assets WHERE id = $1 AND active', [b.asset_id]);
  if (!asset) throw NOT_FOUND('Activo');
  if (asset.chain !== 'ethereum' || asset.network !== config.ALCHEMY_NETWORK || !['native', 'erc20'].includes(asset.kind)) {
    throw new HttpError(422, `Retiros de ${asset.id} no habilitados en esta red`, 'network_not_supported');
  }
  const { rows: [wl] } = await pool.query(
    `SELECT * FROM wallets WHERE id = $1 AND client_id = $2 AND purpose = 'withdrawal_whitelist'`, [b.whitelist_id, clientId]);
  if (!wl) throw NOT_FOUND('Dirección');
  if (wl.wl_status !== 'active' || !wl.active) throw new HttpError(422, 'La dirección no está activa en su lista blanca', 'address_not_whitelisted');
  if (wl.network !== asset.network) throw new HttpError(422, 'La dirección es de otra red', 'network_mismatch');
  if (wl.active_from && new Date(wl.active_from) > new Date()) {
    throw new HttpError(422, `La dirección estará disponible a partir de ${new Date(wl.active_from).toISOString()}`, 'address_cooling');
  }
  const amount = BigInt(b.amount);
  const acc = await tx((c) => openClientAccount(c, clientId, asset.id));
  const available = BigInt(acc.balance);
  if (amount > available) throw new HttpError(422, 'Saldo disponible insuficiente', 'insufficient_funds');
  const fee = 0n; // comisión de 856 por salida: hoy 0 (preparado para cobrarla)
  const payable = await payableOf(pool, clientId, asset.id);
  const gas = await estimateGas(asset, wl.address, amount);
  const scope_hash = exitScopeHash({ client_id: clientId, asset_id: asset.id, wallet_id: wl.id, to_address: wl.address,
    amount, fee, payable_open: payable.total });
  const { rows: [sim] } = await pool.query(
    `INSERT INTO exit_simulations (client_id, origin_kind, origin_ref, asset_id, wallet_id, to_address, amount, fee, gas_estimate,
                                   available, balance_after, payable_open, obligations, scope_hash, expires_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14, now() + make_interval(mins => $15)) RETURNING *`,
    [clientId, origin.kind, origin.ref, asset.id, wl.id, wl.address, amount.toString(), fee.toString(), gas,
      available.toString(), (available - amount - fee).toString(), payable.total.toString(), JSON.stringify(payable.items),
      scope_hash, config.EXIT_SIMULATION_TTL_MIN]);
  return simView(sim, asset);
}

const simView = (s: Record<string, unknown>, asset: { symbol: string; decimals: number; network: string }) => ({
  id: s.id, asset_id: s.asset_id, symbol: asset.symbol, decimals: asset.decimals, network: asset.network,
  whitelist_id: s.wallet_id, to_address: s.to_address, amount: String(s.amount), fee: String(s.fee),
  gas_estimate: s.gas_estimate == null ? null : String(s.gas_estimate), gas_paid_by: '856',
  available: String(s.available), balance_after: String(s.balance_after), payable_open: String(s.payable_open),
  obligations: s.obligations, scope_hash: s.scope_hash, status: s.status, expires_at: s.expires_at, created_at: s.created_at,
});

// ═════════════ Solicitud de salida (reserva) ═════════════
export async function submit(p: PortalPrincipal, simulationId: string, ip: string) {
  const origin = originOf(p);
  const clientId = p.clientId;
  const id = await tx(async (c) => {
    const { rows: [sim] } = await c.query('SELECT * FROM exit_simulations WHERE id = $1 AND client_id = $2 FOR UPDATE', [simulationId, clientId]);
    if (!sim) throw NOT_FOUND('Simulación');
    if (sim.status === 'submitted') throw new HttpError(409, 'Esa simulación ya se solicitó', 'already_submitted');
    if (sim.status === 'expired' || new Date(sim.expires_at) <= new Date()) {
      await c.query(`UPDATE exit_simulations SET status = 'expired' WHERE id = $1`, [sim.id]);
      throw new HttpError(409, 'La simulación venció: simule de nuevo', 'simulation_expired');
    }
    // El alcance debe seguir igual: destino vigente y mismas obligaciones por pagar
    const payable = await payableOf(c, clientId, sim.asset_id);
    const { rows: [wl] } = await c.query(
      `SELECT 1 FROM wallets WHERE id = $1 AND client_id = $2 AND wl_status = 'active' AND active AND (active_from IS NULL OR active_from <= now())`,
      [sim.wallet_id, clientId]);
    if (!wl || payable.total.toString() !== String(sim.payable_open)) {
      throw new HttpError(409, 'Algo cambió desde la simulación (destino u obligaciones): simule de nuevo', 'scope_changed');
    }
    const { rows: [th] } = await c.query(
      'SELECT threshold FROM client_approval_thresholds WHERE client_id = $1 AND asset_id = $2', [clientId, sim.asset_id]);
    const needsClient = th && BigInt(sim.amount) >= BigInt(th.threshold);
    const { rows: [asset] } = await c.query('SELECT dual_treasurer_threshold FROM assets WHERE id = $1', [sim.asset_id]);
    const dual = asset.dual_treasurer_threshold != null && BigInt(sim.amount) >= BigInt(asset.dual_treasurer_threshold);
    const w = await requestWithdrawal({
      client_id: clientId, asset_id: sim.asset_id, to_address: sim.to_address, amount: String(sim.amount),
      idempotency_key: `exit:${sim.id}`, metadata: { simulation_id: sim.id },
      requested_by: origin.kind === 'client_user' ? `portal:${(p as { user: ClientUser }).user.email}` : `llave:${origin.ref}`,
      exit: {
        approval_status: needsClient ? 'client_pending' : 'pending', origin_kind: origin.kind, origin_ref: origin.ref, origin_ip: ip,
        simulation_id: sim.id, scope_hash: sim.scope_hash, dual_required: dual,
      },
    }, c);
    await c.query(`UPDATE exit_simulations SET status = 'submitted' WHERE id = $1`, [sim.id]);
    return w.id as string;
  });
  return getExit(clientId, id);
}

/** Aprobación interna del cliente (approver+, distinto de quien originó; 2FA en la ruta). Pasa a validación de 856. */
export async function clientApprove(u: ClientUser, id: string) {
  if (!roleAtLeast(u.role, 'approver')) throw new HttpError(403, 'Requiere rol approver', 'forbidden');
  await tx(async (c) => {
    const { rows: [w] } = await c.query('SELECT * FROM withdrawals WHERE id = $1 AND client_id = $2 FOR UPDATE', [id, u.client_id]);
    if (!w || !w.simulation_id) throw NOT_FOUND('Salida');
    if (w.status !== 'reserved' || w.approval_status !== 'client_pending') {
      throw new HttpError(409, 'La salida no espera la aprobación de su empresa', 'not_pending');
    }
    if (w.origin_kind === 'client_user' && w.origin_ref === u.id) {
      throw new HttpError(403, 'Quien originó la salida no puede aprobarla', 'same_user');
    }
    await assertScopeUnchanged(c, w);
    await c.query(
      `UPDATE withdrawals SET approval_status = 'pending', client_approved_by = $2, client_approved_at = now(),
              validation_due_at = now() + make_interval(mins => $3), updated_at = now() WHERE id = $1`,
      [id, u.id, config.EXIT_VALIDATION_SLA_MIN]);
  });
  return getExit(u.client_id, id);
}

/** Cancelación por el cliente (operator+) mientras 856 no la haya autorizado. Devuelve el saldo reservado. */
export async function clientCancel(p: PortalPrincipal, id: string) {
  if (p.kind === 'client_user' && !roleAtLeast(p.user.role, 'operator')) throw new HttpError(403, 'Requiere rol operator', 'forbidden');
  const { rows: [w] } = await pool.query('SELECT * FROM withdrawals WHERE id = $1 AND client_id = $2', [id, p.clientId]);
  if (!w || !w.simulation_id) throw NOT_FOUND('Salida');
  if (w.status !== 'reserved' || !['client_pending', 'pending'].includes(w.approval_status) || w.approved_by_operator) {
    throw new HttpError(409, 'La salida ya no se puede cancelar desde el portal', 'not_cancellable');
  }
  const who = p.kind === 'client_user' ? `portal:${p.user.email}` : `llave:${p.key.prefix}`;
  await cancelWithdrawal(id, `cancelado por el cliente (${who})`);
  await pool.query(`UPDATE withdrawals SET approval_status = 'rejected', rejected_by = $2, rejected_reason = 'cancelado por el cliente' WHERE id = $1`, [id, who]);
  return getExit(p.clientId, id);
}

// ═════════════ Consulta (vista del cliente: nada interno de 856) ═════════════
function stateOf(w: Record<string, unknown>) {
  if (w.status === 'cancelled') return w.rejected_by && !String(w.rejected_by).startsWith('portal:') && !String(w.rejected_by).startsWith('llave:') ? 'rejected' : 'cancelled';
  if (w.status === 'failed') return 'failed';
  if (w.status === 'confirmed') return 'executed';
  if (w.status === 'signed' || w.status === 'broadcast') return 'sent';
  if (w.approval_status === 'client_pending') return 'client_approval';
  if (w.approval_status === 'pending') return 'validation';
  return 'authorized';
}

const EXIT_COLS = `w.id, w.asset_id, s.symbol, s.decimals, s.network, w.to_address, w.amount::text AS amount, w.status, w.approval_status,
  w.tx_hash, w.confirmations, w.origin_kind, w.origin_ref, w.simulation_id, w.scope_hash, w.dual_required,
  w.client_approved_at, w.approved_at, w.approved2_at, w.rejected_by, w.rejected_reason, w.validation_due_at, w.last_error,
  w.created_at, w.updated_at, w.created_at::text AS _ts,
  (SELECT u.name FROM client_users u WHERE u.id::text = w.origin_ref) AS origin_user,
  (SELECT u.name FROM client_users u WHERE u.id = w.client_approved_by) AS client_approver`;

const exitView = (w: Record<string, unknown>) => ({
  id: w.id, asset_id: w.asset_id, symbol: w.symbol, decimals: w.decimals, network: w.network, to_address: w.to_address,
  amount: w.amount, state: stateOf(w), tx_hash: w.tx_hash, confirmations: w.confirmations, required_confirmations: config.CONFIRMATIONS,
  origin: { kind: w.origin_kind, user: w.origin_user ?? null, user_id: w.origin_kind === 'client_user' ? w.origin_ref : null, key: w.origin_kind === 'client_key' ? w.origin_ref : null },
  client_approved_at: w.client_approved_at, client_approver: w.client_approver ?? null,
  // Del lado de 856 solo se informa el hecho y la hora, no quién
  authorized_at: w.approval_status === 'approved' ? (w.approved2_at ?? w.approved_at) : null,
  authorizations: { required: w.dual_required ? 2 : 1, given: (w.approved2_at ? 1 : 0) + (w.approved_at ? 1 : 0) },
  rejection_reason: stateOf(w) === 'rejected' ? w.rejected_reason : null, validation_due_at: w.validation_due_at,
  simulation_id: w.simulation_id, scope_hash: w.scope_hash, created_at: w.created_at, updated_at: w.updated_at,
});

export async function getExit(clientId: string, id: string) {
  const { rows: [w] } = await pool.query(
    `SELECT ${EXIT_COLS} FROM withdrawals w JOIN assets s ON s.id = w.asset_id
      WHERE w.id = $1 AND w.client_id = $2 AND w.simulation_id IS NOT NULL`, [id, clientId]);
  if (!w) throw NOT_FOUND('Salida');
  return exitView(w);
}

const STATE_SQL: Record<string, string> = {
  client_approval: `w.status = 'reserved' AND w.approval_status = 'client_pending'`,
  validation: `w.status = 'reserved' AND w.approval_status = 'pending'`,
  authorized: `w.status = 'reserved' AND w.approval_status = 'approved'`,
  sent: `w.status IN ('signed','broadcast')`,
  executed: `w.status = 'confirmed'`,
  closed: `w.status IN ('cancelled','failed')`,
};

export async function listExits(clientId: string, f: { state?: string; limit: number; cursor?: string }) {
  const { decodeCursor, page } = await import('../pagination.js');
  const cur = decodeCursor(f.cursor);
  const extra = f.state ? `AND ${STATE_SQL[f.state]}` : '';
  const { rows } = await pool.query(
    `SELECT ${EXIT_COLS} FROM withdrawals w JOIN assets s ON s.id = w.asset_id
      WHERE w.client_id = $1 AND w.simulation_id IS NOT NULL ${extra}
        AND ($2::timestamptz IS NULL OR (w.created_at, w.id) < ($2::timestamptz, $3::uuid))
      ORDER BY w.created_at DESC, w.id DESC LIMIT $4`, [clientId, cur?.[0] ?? null, cur?.[1] ?? null, f.limit + 1]);
  const p = page(rows, f.limit);
  return { exits: p.items.map(exitView), next_cursor: p.next_cursor };
}
