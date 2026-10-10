import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { HttpError } from '../idempotency.js';
import { audit, clearSessionCookie, login, revokeSession, setSessionCookie } from '../auth/operators.js';

const LoginBody = z.object({ email: z.string().email().max(200), password: z.string().min(1).max(200) });

// Sesión de operadores de la consola. La x-api-key nunca llega al navegador.
export async function authRoutes(app: FastifyInstance) {
  app.post('/auth/login', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req, reply) => {
    const p = LoginBody.safeParse(req.body);
    if (!p.success) throw new HttpError(400, 'Correo y contraseña requeridos', 'validation_error');
    const r = await login(p.data.email, p.data.password, { ip: req.ip, ua: req.headers['user-agent'] });
    if (!r.ok) {
      await audit({ operator_id: r.operator_id, actor: p.data.email.toLowerCase(), action: 'login_failed', status: 401, ip: req.ip, metadata: { reason: r.reason } });
      // Mismo mensaje para todo: no revela si el correo existe o está bloqueado
      throw new HttpError(401, 'Credenciales inválidas o cuenta bloqueada temporalmente', 'invalid_credentials');
    }
    await audit({ operator_id: r.operator.id, actor: r.operator.email, action: 'login', status: 200, ip: req.ip });
    setSessionCookie(reply, r.token, r.expires_at);
    return { operator: r.operator, expires_at: r.expires_at };
  });

  app.get('/auth/me', async (req) => {
    const p = req.principal;
    if (p?.kind !== 'operator') throw new HttpError(403, 'Solo para sesiones de operador', 'operator_only');
    return { operator: p.operator };
  });

  app.post('/auth/logout', async (req, reply) => {
    const p = req.principal;
    if (p?.kind === 'operator') {
      await revokeSession(p.sessionId);
      await audit({ operator_id: p.operator.id, actor: p.operator.email, action: 'logout', status: 200, ip: req.ip });
    }
    clearSessionCookie(reply);
    return { ok: true };
  });
}
