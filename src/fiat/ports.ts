import type { FiatOrder, FiatToken, FiatIban } from './provider.js';
import type { Signer } from '../chain/signer.js';
import type { FiatProviderId } from './domain.js';

export interface FiatIngressPort {
  readonly name: FiatProviderId;
  readonly live: boolean;
  chainName(): string;
  token(): Promise<string>;
  profileId(): Promise<string | null>;
  linkAddress(i: { address: string; signer: Signer }): Promise<{ state: string }>;
  requestIban(i: { address: string }): Promise<void>;
  getIban(address: string): Promise<FiatIban | null>;
  listOrders(address: string, since?: Date): Promise<FiatOrder[]>;
  tokens(): Promise<FiatToken[]>;
  parseWebhook(headers: Record<string, unknown>, rawBody: string): { verified: boolean; order_ids: string[] };
}

export interface CryptoCustodyPort {
  verifyFiatMint(i: {
    network: string;
    contractAddress: string;
    destination: string;
    transactionHash: string;
    amount: bigint;
  }): Promise<{ verified: boolean; confirmations: number; blockNumber: bigint | null; logIndex: number | null; reason?: string }>;
}
