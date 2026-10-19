import { createHash, randomBytes } from 'node:crypto';
import { pool } from '../db.js';
import { HttpError } from '../idempotency.js';

const sha = (value: string) => createHash('sha256').update(value).digest('hex');

export async function issueAssistToken(input: {
  clientId: string;
  operatorId: string;
  operatorEmail: string;
  operatorName: string;
  ip: string;
  userAgent?: string;
  trigger: string;
}) {
  const token = `ast_${randomBytes(32).toString('base64url')}`;
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const { rows: [client] } = await c.query<{ id: string; status: string }>(
      'SELECT id, status FROM clients WHERE id = $1 FOR SHARE',
      [input.clientId],
    );
    if (!client) throw new HttpError(404, 'Cliente no encontrado', 'not_found');
    if (client.status === 'closed') throw new HttpError(409, 'Cliente cerrado', 'client_closed');

    const { rows: [issued] } = await c.query<{ expires_at: Date }>(
      `INSERT INTO client_assist_tokens
         (token_hash, client_id, operator_id, operator_email, operator_name, ip, user_agent, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,now() + interval '10 minutes')
       RETURNING expires_at`,
      [sha(token), input.clientId, input.operatorId, input.operatorEmail, input.operatorName, input.ip, input.userAgent?.slice(0, 300) ?? null],
    );
    await c.query(
      `INSERT INTO audit_log (operator_id, actor, action, target, status, ip, metadata, client_id)
       VALUES ($1,$2,'client_impersonation_initiated',$3,200,$4,$5,$6)`,
      [input.operatorId, `console:${input.operatorEmail}`, input.clientId,
        input.ip, { result: 'success', trigger: input.trigger }, input.clientId],
    );
    await c.query('COMMIT');
    return { token, expires_at: issued.expires_at };
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    c.release();
  }
}

export async function activateAssistToken(token: string) {
  if (!/^ast_[A-Za-z0-9_-]{40,60}$/.test(token)) throw new HttpError(401, 'Token de asistencia inválido o vencido', 'invalid_assist_token');
  const sessionToken = `asr_${randomBytes(32).toString('base64url')}`;
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const { rows: [session] } = await c.query(
      `UPDATE client_assist_tokens t SET activated_at = now(), session_hash = $2
        FROM clients cl
       WHERE t.token_hash = $1 AND t.client_id = cl.id AND t.status = 'active'
         AND t.activated_at IS NULL AND t.expires_at > now() AND cl.status <> 'closed'
       RETURNING t.client_id, t.operator_email, t.operator_name, t.expires_at, cl.name AS client_name, cl.kind, cl.status AS client_status`,
      [sha(token), sha(sessionToken)],
    );
    if (!session) throw new HttpError(401, 'Token de asistencia inválido o vencido', 'invalid_assist_token');
    await c.query('COMMIT');
    return { session_token: sessionToken, ...session };
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    c.release();
  }
}

export async function assistSessionFromToken(token: string | undefined) {
  if (!token || token.length > 100 || !token.startsWith('asr_')) return null;
  const { rows: [session] } = await pool.query(
    `SELECT t.client_id, t.operator_id, t.operator_email, t.operator_name, t.expires_at
       FROM client_assist_tokens t JOIN clients c ON c.id = t.client_id
      WHERE t.session_hash = $1 AND t.status = 'active' AND t.activated_at IS NOT NULL
        AND t.revoked_at IS NULL AND t.expires_at > now() AND c.status <> 'closed'`,
    [sha(token)],
  );
  return session ?? null;
}

export async function revokeAssistSession(token: string | undefined) {
  if (!token || token.length > 100 || !token.startsWith('asr_')) return false;
  const { rowCount } = await pool.query(
    `UPDATE client_assist_tokens SET status = 'revoked', revoked_at = now()
      WHERE session_hash = $1 AND status = 'active' AND revoked_at IS NULL AND expires_at > now()`,
    [sha(token)],
  );
  return !!rowCount;
}
