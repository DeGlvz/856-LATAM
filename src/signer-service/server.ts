import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { appendFileSync, existsSync } from 'node:fs';
import { keccak256, parseTransaction, type Address, type Hex } from 'viem';
import { decrypt, depositAccount, hotAccount, readKeystore, type KeystoreFile, type Secrets } from './keystore.js';
import { DailyLedger, evaluateMessage, evaluateTx, loadPolicy, type Policy } from './policy.js';

/**
 * Servicio firmante 856 (droplet prod856-signer). Guarda las llaves; la app solo pide firmas.
 *
 *  API (red privada, HMAC):  GET /v1/info · POST /v1/sign/tx · POST /v1/sign/message
 *  Admin (solo 127.0.0.1):   GET /admin/status · POST /admin/unlock · POST /admin/lock
 *
 * Arranca BLOQUEADO: las llaves se descifran solo cuando el operador escribe la contraseña (desbloqueo manual).
 */

export interface SignerOptions {
  keystorePath: string;
  policyPath: string;
  secret: string;
  ledgerPath?: string;
  auditPath?: string;
  pausePath?: string;
  windowSec?: number;
}

const MAX_BODY = 64 * 1024;

export function createSignerService(o: SignerOptions) {
  const ks: KeystoreFile = readKeystore(o.keystorePath);
  const policy: Policy = loadPolicy(o.policyPath);
  const ledger = new DailyLedger(o.ledgerPath);
  const windowSec = o.windowSec ?? 60;
  const seen = new Map<string, number>(); // nonce → expira (anti-repetición)
  let secrets: Secrets | null = null;

  const audit = (e: Record<string, unknown>) => {
    if (!o.auditPath) return;
    appendFileSync(o.auditPath, JSON.stringify({ ts: new Date().toISOString(), ...e }, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)) + '\n', { mode: 0o600 });
  };

  function verifyHmac(req: IncomingMessage, path: string, body: string): string | null {
    const ts = Number(req.headers['x-856-ts']);
    const nonce = String(req.headers['x-856-nonce'] ?? '');
    const sig = String(req.headers['x-856-sig'] ?? '');
    const now = Math.floor(Date.now() / 1000);
    if (!Number.isFinite(ts) || Math.abs(now - ts) > windowSec) return 'firma fuera de ventana';
    if (!/^[0-9a-f]{32}$/.test(nonce)) return 'nonce inválido';
    for (const [n, exp] of seen) if (exp < now) seen.delete(n);
    if (seen.has(nonce)) return 'solicitud repetida';
    const mac = createHmac('sha256', o.secret).update(`${ts}.${nonce}.${req.method}.${path}.${body}`).digest();
    const got = Buffer.from(sig, 'hex');
    if (got.length !== mac.length || !timingSafeEqual(got, mac)) return 'firma HMAC inválida';
    seen.set(nonce, now + windowSec * 2);
    return null;
  }

  function accountFor(ref: any) {
    if (!secrets) throw new Error('firmante bloqueado');
    if (ref?.kind === 'hot') return hotAccount(secrets);
    if (ref?.kind === 'deposit' && Number.isInteger(ref.index) && ref.index >= 0 && ref.index < 2 ** 31) return depositAccount(secrets, ref.index);
    throw new Error('referencia de llave inválida');
  }

  const send = (res: ServerResponse, code: number, data: unknown) => {
    res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify(data));
  };

  async function readBody(req: IncomingMessage): Promise<string> {
    let size = 0;
    const chunks: Buffer[] = [];
    for await (const c of req) {
      size += (c as Buffer).length;
      if (size > MAX_BODY) throw new Error('cuerpo demasiado grande');
      chunks.push(c as Buffer);
    }
    return Buffer.concat(chunks).toString('utf8');
  }

  /** API para la app (red privada). */
  const api = createServer(async (req, res) => {
    const path = (req.url ?? '').split('?')[0];
    try {
      const body = await readBody(req);
      const authErr = verifyHmac(req, path, body);
      if (authErr) { audit({ event: 'auth_rejected', path, reason: authErr, ip: req.socket.remoteAddress }); return send(res, 401, { error: authErr }); }

      if (req.method === 'GET' && path === '/v1/info') return send(res, 200, { hot: ks.hot, xpub: ks.xpub, locked: !secrets });
      if (req.method !== 'POST') return send(res, 404, { error: 'ruta desconocida' });
      if (existsSync(o.pausePath ?? '/nonexistent')) { audit({ event: 'paused', path }); return send(res, 423, { error: 'firmante en pausa de emergencia' }); }
      if (!secrets) return send(res, 423, { error: 'firmante bloqueado: falta desbloqueo manual' });

      const j = JSON.parse(body || '{}');
      const account = accountFor(j.ref);
      if (String(j.from ?? '').toLowerCase() !== account.address.toLowerCase()) return send(res, 400, { error: 'from no corresponde a la llave' });

      if (path === '/v1/sign/tx') {
        const unsigned = j.unsigned as Hex;
        const tx = parseTransaction(unsigned) as any;
        if (tx.type !== 'eip1559') return send(res, 400, { error: 'solo transacciones EIP-1559' });
        if (tx.r || tx.s) return send(res, 400, { error: 'la transacción ya viene firmada' });
        const d = evaluateTx(policy, { ref: j.ref, from: account.address, chainId: tx.chainId, nonce: tx.nonce, to: tx.to, value: tx.value ?? 0n, data: tx.data }, ks.hot as Address, ledger);
        if (!d.ok) { audit({ event: 'tx_rejected', ref: j.ref, from: account.address, chainId: tx.chainId, nonce: tx.nonce, to: tx.to, reason: d.reason }); return send(res, 403, { error: d.reason }); }
        const signed = await account.signTransaction(tx);
        if (d.ledgerKey) ledger.record(d.ledgerKey, d.asset, d.amount);
        audit({ event: 'tx_signed', ref: j.ref, from: account.address, chainId: tx.chainId, nonce: tx.nonce, to: tx.to, asset: d.asset, amount: d.amount, hash: keccak256(signed) });
        return send(res, 200, { signed });
      }
      if (path === '/v1/sign/message') {
        const d = evaluateMessage(policy, String(j.message ?? ''));
        if (!d.ok) { audit({ event: 'msg_rejected', ref: j.ref, from: account.address, reason: d.reason }); return send(res, 403, { error: d.reason }); }
        const signature = await account.signMessage({ message: j.message });
        audit({ event: 'msg_signed', ref: j.ref, from: account.address });
        return send(res, 200, { signature });
      }
      return send(res, 404, { error: 'ruta desconocida' });
    } catch (e) {
      audit({ event: 'error', path, error: (e as Error).message });
      return send(res, 400, { error: (e as Error).message });
    }
  });

  /** Administración local (solo 127.0.0.1): desbloqueo manual con contraseña. */
  const admin = createServer(async (req, res) => {
    const path = (req.url ?? '').split('?')[0];
    const ip = req.socket.remoteAddress ?? '';
    if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(ip)) return send(res, 403, { error: 'solo local' });
    try {
      if (req.method === 'GET' && path === '/admin/status') return send(res, 200, { hot: ks.hot, xpub: ks.xpub, locked: !secrets, paused: existsSync(o.pausePath ?? '/nonexistent') });
      if (req.method === 'POST' && path === '/admin/unlock') {
        const { passphrase } = JSON.parse(await readBody(req) || '{}');
        secrets = decrypt(ks, String(passphrase ?? ''));
        audit({ event: 'unlocked' });
        return send(res, 200, { locked: false, hot: ks.hot });
      }
      if (req.method === 'POST' && path === '/admin/lock') { secrets = null; audit({ event: 'locked' }); return send(res, 200, { locked: true }); }
      return send(res, 404, { error: 'ruta desconocida' });
    } catch (e) {
      audit({ event: 'unlock_failed', error: (e as Error).message });
      return send(res, 400, { error: (e as Error).message });
    }
  });

  return { api, admin, isLocked: () => !secrets, info: () => ({ hot: ks.hot, xpub: ks.xpub }) };
}
