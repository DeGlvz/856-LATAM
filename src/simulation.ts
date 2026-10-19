import { createHash } from 'node:crypto';
import { pool, type Tx } from './db.js';

export interface SimulationIssue {
  fila: number;
  campo: string;
  motivo: string;
}

export async function rollbackOnly<T>(
  work: (c: Tx) => Promise<T>,
  connect: () => Promise<Tx> = () => pool.connect(),
): Promise<T> {
  const c = await connect();
  let started = false;
  try {
    await c.query('BEGIN');
    started = true;
    return await work(c);
  } finally {
    try {
      if (started) await c.query('ROLLBACK');
    } finally {
      c.release();
    }
  }
}

export function simulationFingerprint(scope: unknown) {
  return createHash('sha256').update(JSON.stringify(scope)).digest('hex');
}

export function simulationResult(fingerprint: string, result: Record<string, unknown> = {}) {
  return {
    ...result,
    fingerprint,
    provider_calls: 0,
    emulation: {
      wallet: `0x${fingerprint.slice(0, 40)}`,
      iban: `ZZ00SIMU${fingerprint.slice(0, 12).toUpperCase()}`,
      webhook: { status: 'processed', source: 'internal_test' },
    },
  };
}
