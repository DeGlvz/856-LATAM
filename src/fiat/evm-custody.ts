import { decodeEventLog, erc20Abi, type Address, type Hash } from 'viem';
import { findNet } from '../chain/networks.js';
import type { CryptoCustodyPort } from './ports.js';

const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const CENT_TO_TOKEN = 10n ** 16n;

export class EvmFiatCustodyAdapter implements CryptoCustodyPort {
  async verifyFiatMint(i: {
    network: string; contractAddress: string; destination: string; transactionHash: string; amount: bigint;
  }) {
    const n = findNet(i.network);
    if (!n) return { verified: false, confirmations: 0, blockNumber: null, logIndex: null, reason: 'red fiat no disponible' };
    const receipt = await n.client.getTransactionReceipt({ hash: i.transactionHash as Hash }).catch(() => null);
    if (!receipt) return { verified: false, confirmations: 0, blockNumber: null, logIndex: null, reason: 'pending' };
    if (receipt.status !== 'success') {
      return { verified: false, confirmations: 0, blockNumber: receipt.blockNumber, logIndex: null, reason: 'la transacción de acuñación revirtió' };
    }
    let hit: { amount: bigint; logIndex: number } | null = null;
    for (const log of receipt.logs) {
      if (log.address.toLowerCase() !== i.contractAddress.toLowerCase() || log.topics[0] !== TRANSFER_TOPIC) continue;
      const event = decodeEventLog({ abi: erc20Abi, data: log.data, topics: log.topics });
      const { to, value } = event.args as { to: Address; value: bigint };
      if (event.eventName === 'Transfer' && to.toLowerCase() === i.destination.toLowerCase()) {
        hit = { amount: value, logIndex: log.logIndex };
        break;
      }
    }
    if (!hit) {
      return { verified: false, confirmations: 0, blockNumber: receipt.blockNumber, logIndex: null,
        reason: 'la transacción no transfiere EURe a la dirección de la cuenta fiat' };
    }
    if (hit.amount !== i.amount) {
      const eur = (v: bigint) => v % CENT_TO_TOKEN === 0n ? `${v / CENT_TO_TOKEN / 100n}.${(v / CENT_TO_TOKEN % 100n).toString().padStart(2, '0')} €` : `${v} unidades base`;
      return { verified: false, confirmations: 0, blockNumber: receipt.blockNumber, logIndex: hit.logIndex,
        reason: `monto acuñado (${eur(hit.amount)}) distinto al de la orden (${eur(i.amount)})` };
    }
    const head = await n.client.getBlockNumber({ cacheTime: 0 });
    return {
      verified: true, confirmations: Number(head - receipt.blockNumber + 1n),
      blockNumber: receipt.blockNumber, logIndex: hit.logIndex,
    };
  }
}
