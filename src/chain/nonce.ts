import type { Address } from 'viem';
import type { Tx } from '../db.js';
import type { Net } from './networks.js';

/**
 * Siguiente nonce de una dirección de la plataforma EN UNA RED: el mayor entre lo que ve esa red (pendientes incluidos)
 * y lo que ya firmamos en ella (retiros y barridos). La misma hot wallet firma en varias redes: cada una lleva su
 * propia secuencia. Se llama con el candado del worker tomado, así que no hay carreras.
 */
export async function nextNonce(c: Tx, n: Net, from: string): Promise<number> {
  const chainNonce = await n.client.getTransactionCount({ address: from as Address, blockTag: 'pending' });
  const { rows: [m] } = await c.query(
    `SELECT COALESCE(MAX(x) + 1, 0) AS n FROM (
       SELECT nonce AS x FROM withdrawals WHERE network = $2 AND from_address = $1 AND status IN ('signed','broadcast','confirmed')
       UNION ALL
       SELECT nonce FROM sweeps WHERE network = $2 AND from_address = $1 AND status IN ('signed','broadcast','confirmed')
     ) t`,
    [from, n.id],
  );
  return Math.max(chainNonce, Number(m.n));
}
