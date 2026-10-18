import { createHash } from 'node:crypto';

export type FiatAccountStatus = 'pending_link' | 'linked' | 'iban_requested' | 'active' | 'closed';
export type FiatTransactionStatus = 'CREATED' | 'PROCESSING' | 'SETTLED' | 'FAILED';
export type FiatProviderId = 'monerium' | 'mock' | 'transak' | 'circle';

export interface FiatAccount {
  id: string;
  clientId: string | null;
  providerId: string;
  address: string;
  network: string;
  status: FiatAccountStatus;
}

export interface FiatTransaction {
  id: string;
  clientId: string | null;
  accountId: string;
  providerId: string;
  externalTxId: string;
  status: FiatTransactionStatus;
}

export const toFiatTransactionStatus = (status: string): FiatTransactionStatus => {
  if (status === 'received') return 'CREATED';
  if (status === 'minted') return 'PROCESSING';
  if (status === 'reconciled' || status === 'released') return 'SETTLED';
  return 'FAILED';
};

export const fiatIdempotencyKey = (providerId: string, externalTxId: string, clientId: string | null) =>
  createHash('sha256').update(`${providerId}${externalTxId}${clientId ?? ''}`).digest('hex');
