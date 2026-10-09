import type { Address } from 'viem';
import { client } from '../chain.js';
import type { Tx } from '../db.js';

/**
 * Siguiente nonce de una dirección de la plataforma: el mayor entre lo que ve la red (pendientes incluidos)
 * y lo que ya firmamos (retiros y barridos). Se llama con el candado del worker tomado, así que no hay carreras.
 */
export async function nextNonce(c: Tx, from: string): Promise<number> {
  const chainNonce = await client.getTransactionCount({ address: from as Address, blockTag: 'pending' });
  const { rows: [m] } = await c.query(
    `SELECT COALESCE(MAX(n) + 1, 0) AS n FROM (
       SELECT nonce AS n FROM withdrawals WHERE from_address = $1 AND status IN ('signed','broadcast','confirmed')
       UNION ALL
       SELECT nonce FROM sweeps WHERE from_address = $1 AND status IN ('signed','broadcast','confirmed')
     ) t`,
    [from],
  );
  return Math.max(chainNonce, Number(m.n));
}
