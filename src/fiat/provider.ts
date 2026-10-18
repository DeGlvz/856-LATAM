// Fase F1 — frontera de estrategia para ingress fiat. El flujo de cuenta/cliente es independiente del proveedor.
//
// Implementaciones:
//   • MoneriumProvider: API v2 de Monerium (Accept: application/vnd.monerium.api-v2+json), OAuth client credentials.
//     Rutas y tipos tomados del SDK oficial @monerium/sdk 4.2 (auth/token, addresses, ibans, orders, tokens).
//     Solo setup (ligar dirección, pedir IBAN) y lecturas: esta fase NO crea órdenes ni usa el permiso «Create payments».
//   • MockFiatProvider: en memoria, para pruebas e2e y el despliegue sandbox. Nunca sale a la red.
import { createHmac, timingSafeEqual } from 'node:crypto';
import { verifyMessage, type Address, type Hex } from 'viem';
import { config, isProduction } from '../config.js';
import type { Signer } from '../chain/signer.js';
import { HttpError } from '../idempotency.js';
import type { FiatIngressPort } from './ports.js';
import type { FiatProviderId } from './domain.js';

export const LINK_MESSAGE = 'I hereby declare that I am the address owner.';

export type OrderState = 'placed' | 'pending' | 'processed' | 'rejected';
export interface FiatOrder {
  id: string;
  kind: 'issue' | 'redeem';
  state: OrderState;
  amount: string;          // EUR en unidades humanas, p. ej. "1250.5" (máx. 2 decimales)
  currency: string;        // 'eur'
  address: string;         // dirección que recibe la acuñación
  chain: string;
  memo: string | null;     // concepto de la transferencia SEPA (referencia del aviso)
  payer_name: string | null;
  payer_iban: string | null;
  tx_hashes: string[];
  placed_at: string | null;
  processed_at: string | null;
  rejected_reason: string | null;
  raw: unknown;
}
export interface FiatIban { iban: string; bic: string | null; name: string | null; state: string; address: string; chain: string }
export interface FiatToken { symbol: string; chain: string; address: string; decimals: number }

export interface FiatProvider extends FiatIngressPort {
  readonly name: FiatProviderId;
}

// ═════════════ Monerium ═════════════
const MONERIUM_API = { production: 'https://api.monerium.app', sandbox: 'https://api.monerium.dev' } as const;
let moneriumCalls = 0;
/** Llamadas HTTP hechas a Monerium desde el arranque (la prueba de FIAT_LIVE_ENABLED=false exige 0). */
export const providerCalls = () => moneriumCalls;

type RawOrder = {
  id: string; kind: 'issue' | 'redeem'; state: OrderState; amount: string; currency: string; address: string; chain: string; memo?: string;
  counterpart?: { identifier?: { standard?: string; iban?: string }; details?: { name?: string; firstName?: string; lastName?: string; companyName?: string } };
  meta?: { placedAt?: string; processedAt?: string; rejectedReason?: string; txHashes?: string[] };
};

export class MoneriumProvider implements FiatProvider {
  readonly name = 'monerium' as const;
  readonly live = true;
  private base = MONERIUM_API[config.MONERIUM_ENV];
  private cached: { token: string; profile: string | null; exp: number } | null = null;

  chainName() { return config.MONERIUM_ENV === 'production' ? 'base' : 'basesepolia'; }

  private async http<T>(method: string, path: string, body?: unknown, form = false): Promise<T> {
    moneriumCalls++;
    const headers: Record<string, string> = { Accept: 'application/vnd.monerium.api-v2+json' };
    if (!path.startsWith('auth/token') && !path.startsWith('tokens')) headers.Authorization = `Bearer ${await this.token()}`;
    if (body !== undefined) headers['Content-Type'] = form ? 'application/x-www-form-urlencoded' : 'application/json';
    const res = await fetch(`${this.base}/${path}`, {
      method, headers, signal: AbortSignal.timeout(15_000),
      body: body === undefined ? undefined : form ? new URLSearchParams(body as Record<string, string>).toString() : JSON.stringify(body),
    });
    const text = await res.text();
    if (res.status === 429) throw new HttpError(503, 'Monerium limitó la tasa de peticiones; se reintenta en el siguiente ciclo', 'provider_rate_limited');
    if (!res.ok) {
      // Nunca se reenvía el cuerpo completo (puede traer datos personales); solo código y mensaje corto
      let msg = text.slice(0, 200);
      try { const j = JSON.parse(text); msg = String(j.message ?? j.error_description ?? j.error ?? msg).slice(0, 200); } catch { /* texto plano */ }
      throw new HttpError(502, `Monerium ${res.status}: ${msg}`, 'provider_error');
    }
    return (text ? JSON.parse(text) : {}) as T;
  }

  async token() {
    if (this.cached && this.cached.exp > Date.now() + 30_000) return this.cached.token;
    if (!config.MONERIUM_CLIENT_ID || !config.MONERIUM_CLIENT_SECRET) {
      throw new HttpError(503, 'Faltan MONERIUM_CLIENT_ID / MONERIUM_CLIENT_SECRET', 'provider_not_configured');
    }
    const r = await this.http<{ access_token: string; expires_in: number; profile?: string }>('POST', 'auth/token', {
      grant_type: 'client_credentials', client_id: config.MONERIUM_CLIENT_ID, client_secret: config.MONERIUM_CLIENT_SECRET,
    }, true);
    this.cached = { token: r.access_token, profile: r.profile ?? null, exp: Date.now() + Number(r.expires_in ?? 300) * 1000 };
    return r.access_token;
  }

  async profileId() { await this.token(); return this.cached?.profile ?? null; }

  async linkAddress(i: { address: string; signer: Signer }) {
    const signature = await i.signer.signMessage(LINK_MESSAGE);
    const r = await this.http<{ state?: string; code?: number }>('POST', 'addresses', {
      profile: (await this.profileId()) ?? undefined, address: i.address, message: LINK_MESSAGE, signature, chain: this.chainName(),
    });
    return { state: r.state ?? (r.code === 202 ? 'pending' : 'linked') };
  }

  async requestIban(i: { address: string }) {
    await this.http('POST', 'ibans', { address: i.address, chain: this.chainName(), emailNotifications: false });
  }

  async getIban(address: string) {
    const profile = await this.profileId();
    const q = new URLSearchParams({ chain: this.chainName(), ...(profile ? { profile } : {}) });
    const r = await this.http<{ ibans?: { iban: string; bic?: string; name?: string; state: string; address: string; chain: string }[] }>('GET', `ibans?${q}`);
    const hit = (r.ibans ?? []).find((x) => x.address.toLowerCase() === address.toLowerCase());
    return hit ? { iban: hit.iban.replace(/\s/g, ''), bic: hit.bic ?? null, name: hit.name ?? null, state: hit.state, address: hit.address, chain: hit.chain } : null;
  }

  async listOrders(address: string, since?: Date) {
    const r = await this.http<{ orders?: RawOrder[] }>('GET', `orders?${new URLSearchParams({ address })}`);
    return (r.orders ?? []).map(normalize).filter((o) => !since || !o.placed_at || new Date(o.placed_at) >= since);
  }

  async tokens() {
    const r = await this.http<{ symbol: string; chain: string; address: string; decimals: number }[]>('GET', 'tokens');
    return (Array.isArray(r) ? r : []).map((t) => ({ symbol: t.symbol, chain: t.chain, address: t.address.toLowerCase(), decimals: Number(t.decimals) }));
  }

  /**
   * Webhooks de Monerium (formato Standard Webhooks): HMAC-SHA256 de `${webhook-id}.${webhook-timestamp}.${cuerpo}`
   * con el secreto whsec_…; encabezado webhook-signature = "v1,<base64>" (puede traer varias). Sin secreto configurado
   * devuelve verified=false; la ruta rechaza el evento y el sondeo periódico continúa normalmente.
   */
  parseWebhook(headers: Record<string, unknown>, rawBody: string) {
    return parseStandardWebhook(headers, rawBody, config.MONERIUM_WEBHOOK_SECRET);
  }
}

export function parseStandardWebhook(headers: Record<string, unknown>, rawBody: string, secret: string | undefined) {
  let verified = false;
  if (secret) {
    const id = String(headers['webhook-id'] ?? ''), ts = String(headers['webhook-timestamp'] ?? ''), sigs = String(headers['webhook-signature'] ?? '');
    const fresh = /^\d+$/.test(ts) && Math.abs(Date.now() / 1000 - Number(ts)) <= 300;
    const key = Buffer.from(secret.replace(/^whsec_/, ''), 'base64');
    const expected = createHmac('sha256', key).update(`${id}.${ts}.${rawBody}`, 'utf8').digest('base64');
    verified = fresh && !!id && sigs.split(' ').some((s) => {
      const v = s.split(',')[1] ?? '';
      return v.length === expected.length && timingSafeEqual(Buffer.from(v), Buffer.from(expected));
    });
    if (!verified) throw new HttpError(401, 'Firma inválida', 'bad_signature');
  }
  const ids = new Set<string>();
  try {
    const j = JSON.parse(rawBody) as { data?: { id?: unknown }; id?: unknown; type?: string };
    if (typeof j.data?.id === 'string') ids.add(j.data.id);
  } catch { /* cuerpo no JSON: solo dispara el sondeo */ }
  return { verified, order_ids: [...ids] };
}

const normalize = (o: RawOrder): FiatOrder => {
  const d = o.counterpart?.details;
  const name = d?.name ?? d?.companyName ?? ([d?.firstName, d?.lastName].filter(Boolean).join(' ') || null);
  return {
    id: o.id, kind: o.kind, state: o.state, amount: String(o.amount), currency: String(o.currency ?? 'eur').toLowerCase(),
    address: String(o.address ?? '').toLowerCase(), chain: o.chain, memo: o.memo?.trim() || null, payer_name: name,
    payer_iban: o.counterpart?.identifier?.standard === 'iban' ? o.counterpart.identifier.iban?.replace(/\s/g, '') ?? null : null,
    tx_hashes: (o.meta?.txHashes ?? []).map((h) => h.toLowerCase()), placed_at: o.meta?.placedAt ?? null,
    processed_at: o.meta?.processedAt ?? null, rejected_reason: o.meta?.rejectedReason ?? null, raw: o,
  };
};

// ═════════════ Simulado ═════════════
/**
 * Proveedor simulado: guarda órdenes e IBAN en memoria. Lo usan las pruebas e2e y el sandbox (simulación de depósitos
 * desde la consola). Verifica la firma de propiedad igual que el real (recupera la dirección del mensaje firmado).
 */
export class MockFiatProvider implements FiatProvider {
  readonly name = 'mock' as const;
  readonly live = false;
  private linked = new Set<string>();
  private ibans = new Map<string, FiatIban>();
  private orders = new Map<string, FiatOrder>();
  private tokenList: FiatToken[] = [];

  chainName() { return 'base-simulada'; }
  async token() { return 'mock'; }
  async profileId() { return 'perfil-simulado'; }

  async linkAddress(i: { address: string; signer: Signer }) {
    const signature = await i.signer.signMessage(LINK_MESSAGE);
    const ok = await verifyMessage({ address: i.address as Address, message: LINK_MESSAGE, signature: signature as Hex });
    if (!ok) throw new HttpError(422, 'La firma de propiedad no corresponde a la dirección', 'bad_ownership_signature');
    this.linked.add(i.address.toLowerCase());
    return { state: 'linked' };
  }

  async requestIban(i: { address: string }) {
    const a = i.address.toLowerCase();
    if (!this.linked.has(a)) throw new HttpError(409, 'Dirección no ligada al perfil', 'address_not_linked');
    // IBAN visiblemente ficticio (país «ZZ»): nunca se confunde con una cuenta real
    this.ibans.set(a, { iban: `ZZ00SIMU${a.slice(2, 14).toUpperCase()}`, bic: 'SIMULADO', name: '856 LATAM (simulado)', state: 'approved', address: a, chain: this.chainName() });
  }

  async getIban(address: string) { return this.ibans.get(address.toLowerCase()) ?? null; }

  async listOrders(address: string, since?: Date) {
    return [...this.orders.values()].filter((o) => o.address === address.toLowerCase() && (!since || !o.placed_at || new Date(o.placed_at) >= since));
  }

  async tokens() { return this.tokenList; }
  setTokens(t: FiatToken[]) { this.tokenList = t; }

  parseWebhook(headers: Record<string, unknown>, rawBody: string) { return parseStandardWebhook(headers, rawBody, config.MONERIUM_WEBHOOK_SECRET); }

  /** Simulación (solo fuera de production): el proveedor registra una transferencia SEPA entrante. */
  simulateOrder(o: { address: string; amount: string; memo?: string | null; payer_name?: string | null; payer_iban?: string | null;
    state?: OrderState; tx_hash?: string | null; id?: string }) {
    const id = o.id ?? `sim-${crypto.randomUUID()}`;
    const now = new Date().toISOString();
    const order: FiatOrder = {
      id, kind: 'issue', state: o.state ?? (o.tx_hash ? 'processed' : 'pending'), amount: o.amount, currency: 'eur',
      address: o.address.toLowerCase(), chain: this.chainName(), memo: o.memo ?? null, payer_name: o.payer_name ?? null,
      payer_iban: o.payer_iban ?? null, tx_hashes: o.tx_hash ? [o.tx_hash.toLowerCase()] : [], placed_at: now,
      processed_at: o.tx_hash ? now : null, rejected_reason: null, raw: { simulated: true },
    };
    this.orders.set(id, order);
    return order;
  }
}

// ═════════════ Selección ═════════════
let current: FiatProvider | null | undefined;
/**
 * production + FIAT_LIVE_ENABLED=true → Monerium; production sin el interruptor → fiat apagado (null);
 * sandbox → siempre el simulado (src/environment.ts rechaza FIAT_LIVE_ENABLED=true en sandbox).
 */
export function getFiatProvider(providerId?: string): FiatProvider | null {
  if (providerId && providerId !== 'monerium' && providerId !== 'mock') {
    throw new HttpError(501, `El proveedor ${providerId} tiene una estrategia definida pero aún no está soportado`, 'provider_not_supported');
  }
  if (isProduction) {
    if (!config.FIAT_LIVE_ENABLED) return null;
    if (providerId && providerId !== 'monerium') throw new HttpError(409, 'En production solo está configurado Monerium', 'provider_not_configured');
    return current ?? (current = new MoneriumProvider());
  }
  if (providerId && providerId !== 'mock') throw new HttpError(409, 'En sandbox solo está configurado el proveedor simulado', 'provider_not_configured');
  return current ?? (current = new MockFiatProvider());
}
export const mockProvider = () => { const p = getFiatProvider(); return p instanceof MockFiatProvider ? p : null; };
