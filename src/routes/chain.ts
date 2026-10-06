import type { FastifyInstance } from 'fastify';
import { formatEther, isAddress, isHash, type Address, type Hash } from 'viem';
import { client, alchemy } from '../chain.js';

const json = (o: unknown) => JSON.parse(JSON.stringify(o, (_, v) => (typeof v === 'bigint' ? v.toString() : v)));

export async function chainRoutes(app: FastifyInstance) {
  app.get('/block/latest', async () => {
    const b = await client.getBlock();
    return json({ number: b.number, hash: b.hash, timestamp: b.timestamp, txCount: b.transactions.length, baseFeePerGas: b.baseFeePerGas });
  });

  app.get<{ Params: { address: string } }>('/address/:address/balance', async (req, reply) => {
    const { address } = req.params;
    if (!isAddress(address)) return reply.code(400).send({ error: 'Dirección inválida' });
    const wei = await client.getBalance({ address: address as Address });
    return { address, wei: wei.toString(), ether: formatEther(wei) };
  });

  app.get<{ Params: { address: string } }>('/address/:address/tokens', async (req, reply) => {
    const { address } = req.params;
    if (!isAddress(address)) return reply.code(400).send({ error: 'Dirección inválida' });
    const r = await alchemy<{ tokenBalances: { contractAddress: string; tokenBalance: string }[] }>(
      'alchemy_getTokenBalances', [address, 'erc20'],
    );
    const tokens = r.tokenBalances
      .filter((t) => BigInt(t.tokenBalance) > 0n)
      .map((t) => ({ contract: t.contractAddress, raw: BigInt(t.tokenBalance).toString() }));
    return { address, tokens };
  });

  app.get<{ Params: { hash: string } }>('/tx/:hash', async (req, reply) => {
    const { hash } = req.params;
    if (!isHash(hash)) return reply.code(400).send({ error: 'Hash inválido' });
    const [tx, receipt] = await Promise.all([
      client.getTransaction({ hash: hash as Hash }),
      client.getTransactionReceipt({ hash: hash as Hash }).catch(() => null),
    ]);
    return json({ tx, status: receipt?.status ?? 'pending', gasUsed: receipt?.gasUsed });
  });
}
