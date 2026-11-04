import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireUser } from '../app.js';
import { HttpError, notFound } from '../lib/errors.js';
import { createToken, listTokens, revokeToken } from './tokens.js';

export const CreateTokenBody = z.object({
  name: z.string().trim().min(1).max(80),
  scope: z.enum(['read', 'write']).default('read'),
  expiresInDays: z.number().int().min(1).max(3650).optional(),
});

/** Tokens are managed in a browser session; `tokenMayUse` keeps tokens themselves out of here. */
export async function tokenRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/tokens', async (req) => {
    const user = requireUser(req);
    return { tokens: listTokens(app.db, user.id) };
  });

  app.post('/api/tokens', async (req, reply) => {
    const user = requireUser(req);
    if (user.mustChangePassword)
      throw new HttpError(403, 'Change your password first', 'must_change_password');
    const body = CreateTokenBody.parse(req.body);
    const expiresAt = body.expiresInDays
      ? new Date(Date.now() + body.expiresInDays * 86_400_000).toISOString()
      : null;
    const { token, record } = createToken(app.db, user.id, {
      name: body.name,
      scope: body.scope,
      expiresAt,
    });
    reply.status(201);
    return { token, record };
  });

  app.delete<{ Params: { id: string } }>('/api/tokens/:id', async (req) => {
    const user = requireUser(req);
    if (!revokeToken(app.db, user.id, req.params.id)) throw notFound('No such token');
    return { ok: true };
  });
}
