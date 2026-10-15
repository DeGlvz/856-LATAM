import { primaryNet } from './chain/networks.js';

// Cliente RPC de la red principal (ALCHEMY_NETWORK). Para varias redes: src/chain/networks.ts (net(id).client).
export const client = primaryNet.client;

// Llamada directa a métodos propietarios de Alchemy (Enhanced APIs) en la red principal.
export async function alchemy<T>(method: string, params: unknown[]): Promise<T> {
  const res = await fetch(primaryNet.rpcUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const body = (await res.json()) as { result?: T; error?: { message: string } };
  if (body.error) throw new Error(`Alchemy ${method}: ${body.error.message}`);
  return body.result as T;
}
