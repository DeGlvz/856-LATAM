import { readFileSync, writeFileSync, existsSync, renameSync } from 'node:fs';
import { decodeFunctionData, erc20Abi, type Address, type Hex } from 'viem';

/**
 * Reglas del firmante. Se evalúan ANTES de firmar; cualquier duda = rechazo.
 *
 *  - Solo redes listadas en la política.
 *  - Direcciones de depósito: solo pueden enviar a la hot wallet (barridos) o cancelar (0 a sí mismas).
 *  - Hot wallet: transferencias nativas o `transfer` ERC-20 de contratos listados, con tope por transacción y por día.
 *  - Reemplazos (mismo nonce, más comisión) no cuentan doble en el tope diario.
 *  - Mensajes: solo los textos listados (p. ej. prueba de propiedad ante el proveedor fiat).
 *  - Pausa de emergencia: si existe el archivo de pausa, se rechaza todo.
 */

export interface Limit { perTx: string; perDay: string }                 // unidades base (wei / unidades del token)
export interface ChainPolicy { native: Limit; tokens: Record<string, Limit> } // llave: contrato en minúsculas
export interface Policy { chains: Record<string, ChainPolicy>; messages: string[] }

export interface TxRequest {
  ref: { kind: 'hot' } | { kind: 'deposit'; index: number };
  from: Address;
  chainId: number;
  nonce: number;
  to: Address | null | undefined;
  value: bigint;
  data: Hex | undefined;
}

export type Decision = { ok: true; asset: string; amount: bigint; ledgerKey?: string } | { ok: false; reason: string };

const TRANSFER = '0xa9059cbb';
const lc = (a?: string | null) => (a ?? '').toLowerCase();

export function loadPolicy(path: string): Policy {
  const p = JSON.parse(readFileSync(path, 'utf8')) as Policy;
  if (!p.chains || !Object.keys(p.chains).length) throw new Error('La política no tiene redes');
  for (const [id, c] of Object.entries(p.chains)) {
    for (const [k, l] of Object.entries({ native: c.native, ...c.tokens })) {
      if (!/^\d+$/.test(l?.perTx ?? '') || !/^\d+$/.test(l?.perDay ?? '')) throw new Error(`Límite inválido en red ${id} (${k})`);
    }
    c.tokens = Object.fromEntries(Object.entries(c.tokens ?? {}).map(([k, v]) => [lc(k), v]));
  }
  p.messages ??= [];
  return p;
}

/** Bitácora de montos del día (persistida) para el tope diario de la hot wallet. */
export class DailyLedger {
  private day = '';
  private spent = new Map<string, { asset: string; amount: bigint }>(); // chainId:from:nonce → mayor monto firmado
  constructor(private path?: string) {
    if (path && existsSync(path)) {
      const j = JSON.parse(readFileSync(path, 'utf8'));
      this.day = j.day;
      for (const [k, v] of Object.entries<any>(j.spent ?? {})) this.spent.set(k, { asset: v.asset, amount: BigInt(v.amount) });
    }
  }
  private roll(now = new Date()) {
    const d = now.toISOString().slice(0, 10); // día UTC
    if (d !== this.day) { this.day = d; this.spent.clear(); }
  }
  totalFor(chainId: number, asset: string, excludeKey?: string, now?: Date) {
    this.roll(now);
    let t = 0n;
    for (const [k, v] of this.spent) if (k !== excludeKey && k.startsWith(`${chainId}:`) && v.asset === asset) t += v.amount;
    return t;
  }
  previous(key: string) { return this.spent.get(key)?.amount ?? 0n; }
  record(key: string, asset: string, amount: bigint, now?: Date) {
    this.roll(now);
    const prev = this.spent.get(key)?.amount ?? 0n;
    this.spent.set(key, { asset, amount: amount > prev ? amount : prev });
    if (this.path) {
      const tmp = `${this.path}.tmp`;
      writeFileSync(tmp, JSON.stringify({ day: this.day, spent: Object.fromEntries([...this.spent].map(([k, v]) => [k, { asset: v.asset, amount: v.amount.toString() }])) }), { mode: 0o600 });
      renameSync(tmp, this.path);
    }
  }
}

export function evaluateTx(p: Policy, r: TxRequest, hot: Address, ledger: DailyLedger, now?: Date): Decision {
  const chain = p.chains[String(r.chainId)];
  if (!chain) return { ok: false, reason: `red ${r.chainId} no permitida` };
  if (!r.to) return { ok: false, reason: 'creación de contratos no permitida' };

  const data = r.data && r.data !== '0x' ? r.data : undefined;
  const to = lc(r.to);
  const self = lc(r.from);

  // Cancelación: 0 a sí misma, sin datos (cualquier llave)
  if (!data && to === self && r.value === 0n) return { ok: true, asset: 'cancel', amount: 0n };

  // ¿Qué se mueve?
  let asset: string;
  let amount: bigint;
  let recipient: string;
  if (!data) {
    asset = 'native'; amount = r.value; recipient = to;
  } else {
    if (r.value !== 0n) return { ok: false, reason: 'una llamada a contrato no puede llevar valor nativo' };
    if (!chain.tokens[to]) return { ok: false, reason: `contrato ${r.to} no está en la lista de tokens permitidos` };
    if (data.slice(0, 10).toLowerCase() !== TRANSFER) return { ok: false, reason: 'solo se permite transfer() de ERC-20' };
    try {
      const d = decodeFunctionData({ abi: erc20Abi, data });
      if (d.functionName !== 'transfer') return { ok: false, reason: 'solo se permite transfer() de ERC-20' };
      recipient = lc(d.args[0] as string); amount = d.args[1] as bigint; asset = to;
    } catch {
      return { ok: false, reason: 'datos de transfer() inválidos' };
    }
  }

  if (r.ref.kind === 'deposit') {
    // Barrido: el destino solo puede ser la hot wallet
    if (recipient !== lc(hot)) return { ok: false, reason: 'una dirección de depósito solo puede enviar a la hot wallet' };
    return { ok: true, asset, amount };
  }

  // Hot wallet: topes por transacción y por día
  const limit = asset === 'native' ? chain.native : chain.tokens[asset];
  if (amount > BigInt(limit.perTx)) return { ok: false, reason: `monto ${amount} supera el tope por transacción (${limit.perTx}) de ${asset}` };
  const key = `${r.chainId}:${self}:${r.nonce}`;
  const prior = ledger.previous(key);
  const charged = amount > prior ? amount : prior;
  const today = ledger.totalFor(r.chainId, asset, key, now) + charged;
  if (today > BigInt(limit.perDay)) return { ok: false, reason: `el tope diario de ${asset} (${limit.perDay}) se excedería (${today})` };
  return { ok: true, asset, amount, ledgerKey: key };
}

export function evaluateMessage(p: Policy, message: string): Decision {
  return p.messages.includes(message) ? { ok: true, asset: 'message', amount: 0n } : { ok: false, reason: 'mensaje no permitido por la política' };
}
