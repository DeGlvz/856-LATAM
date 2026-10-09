import { config } from '../config.js';
import { getDepositKeyring } from '../chain/signer.js';
import { pool, tx } from '../db.js';
import { LedgerError } from './service.js';

type Log = { info: (o: object, m: string) => void; warn: (o: object, m: string) => void };

/** Registra direcciones en el webhook Address Activity de Alchemy (Notify API). */
async function registerOnWebhook(addresses: string[]): Promise<boolean> {
  if (!addresses.length || !config.ALCHEMY_WEBHOOK_ID || !config.ALCHEMY_NOTIFY_TOKEN) return false;
  const res = await fetch(config.ALCHEMY_NOTIFY_URL, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', 'X-Alchemy-Token': config.ALCHEMY_NOTIFY_TOKEN },
    body: JSON.stringify({ webhook_id: config.ALCHEMY_WEBHOOK_ID, addresses_to_add: addresses, addresses_to_remove: [] }),
  });
  if (!res.ok) throw new Error(`Alchemy Notify ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return true;
}

/**
 * Dirección de depósito del cliente, derivada de la semilla HD de la plataforma.
 * Por defecto devuelve la vigente; con `rotate` genera una nueva (la anterior sigue acreditando).
 */
export async function getOrCreateDepositAddress(clientId: string, rotate = false) {
  const keyring = getDepositKeyring();
  if (!keyring) throw new LedgerError(503, 'Direcciones de depósito no configuradas (falta semilla HD)', 'keyring_missing');
  const network = config.ALCHEMY_NETWORK;

  const wallet = await tx(async (c) => {
    const cl = await c.query('SELECT 1 FROM clients WHERE id = $1 FOR UPDATE', [clientId]);
    if (!cl.rowCount) throw new LedgerError(404, 'Cliente no encontrado', 'not_found');
    if (!rotate) {
      const { rows: [w] } = await c.query(
        `SELECT * FROM wallets WHERE client_id = $1 AND network = $2 AND purpose = 'deposit'
           AND derivation_index IS NOT NULL AND active ORDER BY created_at DESC LIMIT 1`, [clientId, network]);
      if (w) return w;
    }
    const { rows: [{ i }] } = await c.query(`SELECT nextval('deposit_address_index')::int AS i`);
    const address = keyring.derive(i).address().toLowerCase();
    const { rows: [w] } = await c.query(
      `INSERT INTO wallets (client_id, chain, network, address, purpose, custody_ref, derivation_path, derivation_index, label)
       VALUES ($1,'ethereum',$2,$3,'deposit',$4,$5,$6,'Dirección de depósito') RETURNING *`,
      [clientId, network, address, `${keyring.kind}:${i}`, `m/44'/60'/0'/0/${i}`, i],
    );
    return w;
  });

  if (!wallet.webhook_registered) {
    try {
      if (await registerOnWebhook([wallet.address])) {
        await pool.query('UPDATE wallets SET webhook_registered = true WHERE id = $1', [wallet.id]);
        wallet.webhook_registered = true;
      }
    } catch { /* el worker reintenta */ }
  }
  return {
    client_id: clientId, network, address: wallet.address, derivation_index: wallet.derivation_index,
    webhook_registered: wallet.webhook_registered, wallet_id: wallet.id,
    note: 'Envíe aquí ETH o tokens ERC-20 soportados; se acreditan al llegar a las confirmaciones requeridas',
  };
}

/** Worker: registra en el webhook las direcciones que quedaron pendientes. */
export async function registerPendingAddresses(log: Log) {
  if (!config.ALCHEMY_WEBHOOK_ID || !config.ALCHEMY_NOTIFY_TOKEN) return;
  const { rows } = await pool.query(
    `SELECT id, address FROM wallets WHERE purpose = 'deposit' AND derivation_index IS NOT NULL
       AND NOT webhook_registered AND active AND network = $1 LIMIT 100`, [config.ALCHEMY_NETWORK]);
  if (!rows.length) return;
  try {
    await registerOnWebhook(rows.map((r) => r.address));
    await pool.query('UPDATE wallets SET webhook_registered = true WHERE id = ANY($1)', [rows.map((r) => r.id)]);
    log.info({ count: rows.length }, 'direcciones registradas en webhook de Alchemy');
  } catch (e) {
    log.warn({ err: (e as Error).message }, 'no se pudieron registrar direcciones en el webhook');
  }
}
