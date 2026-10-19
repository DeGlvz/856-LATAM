import { config } from '../config.js';
import { getDepositKeyring } from '../chain/signer.js';
import { isEnabled, net, primaryNet, type Net } from '../chain/networks.js';
import { pool, tx, type Tx } from '../db.js';
import { LedgerError } from './service.js';

type Log = { info: (o: object, m: string) => void; warn: (o: object, m: string) => void };

/** Registra direcciones en el webhook Address Activity de Alchemy de ESA red (Notify API). */
export async function registerOnWebhook(n: Net, addresses: string[]): Promise<boolean> {
  if (!addresses.length || !n.webhookId || !config.ALCHEMY_NOTIFY_TOKEN) return false;
  const res = await fetch(config.ALCHEMY_NOTIFY_URL, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', 'X-Alchemy-Token': config.ALCHEMY_NOTIFY_TOKEN },
    body: JSON.stringify({ webhook_id: n.webhookId, addresses_to_add: addresses, addresses_to_remove: [] }),
  });
  if (!res.ok) throw new Error(`Alchemy Notify ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return true;
}

/**
 * Dirección de depósito del cliente en una red, derivada de la semilla HD de la plataforma.
 * La dirección EVM derivada es la misma en todas las redes EVM: si el cliente aún no tiene dirección en esta red,
 * se reutiliza su índice vigente de otra red (misma dirección, registrada aparte para acreditar y barrer por red).
 * Con `rotate` se genera un índice nuevo (las anteriores siguen acreditando).
 */
export async function getOrCreateDepositAddress(clientId: string, rotate = false, network: string = primaryNet.id) {
  const keyring = getDepositKeyring();
  if (!keyring) throw new LedgerError(503, 'Direcciones de depósito no configuradas (falta semilla HD)', 'keyring_missing');
  const n = net(network);

  const wallet = await tx(async (c) => {
    const cl = await c.query('SELECT 1 FROM clients WHERE id = $1 FOR UPDATE', [clientId]);
    if (!cl.rowCount) throw new LedgerError(404, 'Cliente no encontrado', 'not_found');
    // Multi-red: solo en redes donde el cliente tiene algún activo habilitado para recibir
    const { rows: [en] } = await c.query(
      `SELECT 1 FROM client_assets ca JOIN assets s ON s.id = ca.asset_id
        WHERE ca.client_id = $1 AND s.network = $2 AND s.active AND ca.status = 'enabled' LIMIT 1`, [clientId, n.id]);
    if (!en) throw new LedgerError(403, `El cliente no tiene activos habilitados en ${n.label}`, 'asset_not_enabled');
    if (!rotate) {
      const { rows: [w] } = await c.query(
        `SELECT * FROM wallets WHERE client_id = $1 AND network = $2 AND purpose = 'deposit'
           AND derivation_index IS NOT NULL AND active AND archived_at IS NULL ORDER BY created_at DESC LIMIT 1`, [clientId, n.id]);
      if (w) return w;
    }

    let i: number | null = null;
    if (!rotate) {
      // Misma dirección que en otra red EVM (si ya existe y no está ocupada en esta red)
      const { rows: [o] } = await c.query(
        `SELECT derivation_index FROM wallets WHERE client_id = $1 AND purpose = 'deposit' AND derivation_index IS NOT NULL AND active
            AND NOT EXISTS (SELECT 1 FROM wallets x WHERE x.network = $2 AND x.address = wallets.address)
          ORDER BY created_at DESC LIMIT 1`, [clientId, n.id]);
      if (o) i = o.derivation_index;
    }
    if (i == null) i = (await c.query(`SELECT nextval('deposit_address_index')::int AS i`)).rows[0].i as number;
    const address = keyring.derive(i).address().toLowerCase();
    const { rows: [w] } = await c.query(
      `INSERT INTO wallets (client_id, chain, network, address, purpose, custody_ref, derivation_path, derivation_index, label)
       VALUES ($1,'ethereum',$2,$3,'deposit',$4,$5,$6,'Dirección de depósito') RETURNING *`,
      [clientId, n.id, address, `${keyring.kind}:${i}`, `m/44'/60'/0'/0/${i}`, i],
    );
    return w;
  });

  if (!wallet.webhook_registered) {
    try {
      if (await registerOnWebhook(n, [wallet.address])) {
        await pool.query('UPDATE wallets SET webhook_registered = true WHERE id = $1', [wallet.id]);
        wallet.webhook_registered = true;
      }
    } catch { /* el worker reintenta */ }
  }
  return {
    client_id: clientId, network: n.id, network_label: n.label, address: wallet.address, derivation_index: wallet.derivation_index,
    webhook_registered: wallet.webhook_registered, wallet_id: wallet.id,
    note: `Envíe aquí solo activos de ${n.label} habilitados para su cuenta; se acreditan al llegar a ${n.confirmations} confirmaciones`,
  };
}

async function depositWallet(c: Tx, clientId: string, walletId: string) {
  await c.query('SELECT id FROM clients WHERE id = $1 FOR UPDATE', [clientId]);
  const { rows: [wallet] } = await c.query(
    `SELECT id, network, active, archived_at
       FROM wallets WHERE id = $1 AND client_id = $2 AND purpose = 'deposit' FOR UPDATE`, [walletId, clientId]);
  if (!wallet) throw new LedgerError(404, 'Dirección de depósito no encontrada', 'not_found');
  const { rows: [activity] } = await c.query(
    `SELECT EXISTS (SELECT 1 FROM deposits WHERE wallet_id = $1)
         OR EXISTS (SELECT 1 FROM sweeps WHERE wallet_id = $1) AS has_activity`, [walletId]);
  return { wallet, hasActivity: activity.has_activity as boolean };
}

async function ensureAnotherVisibleAddress(c: Tx, clientId: string, network: string, walletId: string) {
  if (!isEnabled(network)) return;
  const { rows: [receivable] } = await c.query(
    `SELECT 1 FROM client_assets ca JOIN assets s ON s.id = ca.asset_id
      WHERE ca.client_id = $1 AND s.network = $2 AND s.active AND ca.status = 'enabled' LIMIT 1`, [clientId, network]);
  if (!receivable) return;
  const { rows: [other] } = await c.query(
    `SELECT 1 FROM wallets WHERE client_id = $1 AND network = $2 AND purpose = 'deposit'
       AND active AND archived_at IS NULL AND id <> $3 LIMIT 1`, [clientId, network, walletId]);
  if (!other) throw new LedgerError(409, 'Debe quedar al menos una dirección visible para recibir en esta red', 'last_visible_deposit_address');
}

/** Oculta una dirección con historial sin desactivarla: continúa detectando depósitos y permite barrer fondos. */
export async function archiveDepositAddress(clientId: string, walletId: string, by: string) {
  return tx(async (c) => {
    const { wallet, hasActivity } = await depositWallet(c, clientId, walletId);
    if (!hasActivity) throw new LedgerError(409, 'Esta dirección no tiene movimientos; elimínela en lugar de archivarla', 'wallet_has_no_activity');
    if (wallet.archived_at) return wallet;
    if (wallet.active) await ensureAnotherVisibleAddress(c, clientId, wallet.network, walletId);
    const { rows: [archived] } = await c.query(
      `UPDATE wallets SET archived_at = now(), archived_by = $3 WHERE id = $1 AND client_id = $2 RETURNING id, network, active, archived_at, archived_by`,
      [walletId, clientId, by]);
    await c.query(
      `INSERT INTO audit_log (actor, action, target, status, metadata, client_id)
       VALUES ($1, 'deposit_wallet_archived', $2, 200, $3, $4)`,
      [by, walletId, { network: wallet.network }, clientId]);
    return archived;
  });
}

/** Elimina solo direcciones sin depósitos ni barridos registrados. */
export async function deleteUnusedDepositAddress(clientId: string, walletId: string, by: string) {
  return tx(async (c) => {
    const { wallet, hasActivity } = await depositWallet(c, clientId, walletId);
    if (hasActivity) throw new LedgerError(409, 'Esta dirección tiene movimientos; archívela para conservar su historial', 'wallet_has_activity');
    if (wallet.active && !wallet.archived_at) await ensureAnotherVisibleAddress(c, clientId, wallet.network, walletId);
    await c.query('DELETE FROM wallets WHERE id = $1 AND client_id = $2', [walletId, clientId]);
    await c.query(
      `INSERT INTO audit_log (actor, action, target, status, metadata, client_id)
       VALUES ($1, 'deposit_wallet_deleted', $2, 200, $3, $4)`,
      [by, walletId, { network: wallet.network }, clientId]);
    return { id: walletId, deleted: true };
  });
}

/** Worker: registra en el webhook de la red las direcciones que quedaron pendientes. */
export async function registerPendingAddresses(n: Net, log: Log) {
  if (!n.webhookId || !config.ALCHEMY_NOTIFY_TOKEN) return;
  const { rows } = await pool.query(
    `SELECT id, address FROM wallets WHERE purpose IN ('deposit','fiat_treasury','fiat_client') AND derivation_index IS NOT NULL
       AND NOT webhook_registered AND active AND network = $1 LIMIT 100`, [n.id]);
  if (!rows.length) return;
  try {
    await registerOnWebhook(n, rows.map((r) => r.address));
    await pool.query('UPDATE wallets SET webhook_registered = true WHERE id = ANY($1)', [rows.map((r) => r.id)]);
    log.info({ network: n.id, count: rows.length }, 'direcciones registradas en webhook de Alchemy');
  } catch (e) {
    log.warn({ network: n.id, err: (e as Error).message }, 'no se pudieron registrar direcciones en el webhook');
  }
}
