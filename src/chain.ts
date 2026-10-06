import { createPublicClient, http } from 'viem';
import { rpcUrl } from './config.js';

// Cliente RPC genérico (EVM). La cadena se define por la URL de Alchemy.
export const client = createPublicClient({ transport: http(rpcUrl, { retryCount: 2, timeout: 15_000 }) });

// Llamada directa a métodos propietarios de Alchemy (Enhanced APIs).
export async function alchemy<T>(method: string, params: unknown[]): Promise<T> {
  const res = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const body = (await res.json()) as { result?: T; error?: { message: string } };
  if (body.error) throw new Error(`Alchemy ${method}: ${body.error.message}`);
  return body.result as T;
}
