import { createHash } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Transporter } from 'nodemailer';
import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import type { Auth } from '../auth/auth.js';
import type { AuthConfig } from '../auth/config.js';
import { deliverInvitation, saveInvitation } from '../auth/invitations.js';
import { authHeaders } from '../auth/routes.js';
import { consumeLimit, transaction } from '../mail/store.js';

class AdminError extends Error {
  constructor(
    public statusCode: number,
    message: string,
    public code?: string,
  ) {
    super(message);
  }
}
const identifier = z.string().min(1).max(128);
const confirmation = z.object({ operationId: z.uuid() });
const userAction = confirmation
  .extend({
    action: z.enum(['suspend', 'resume', 'role', 'sessions']),
    expectedRevision: z.number().int().min(0),
    role: z.enum(['user', 'admin']).optional(),
  })
  .strict();
const inviteAction = confirmation
  .extend({
    email: z.string().trim().toLowerCase().email().max(254),
    expectedId: identifier.nullable(),
  })
  .strict();
const revokeInvite = confirmation.extend({ inviteId: identifier }).strict();
const listing = z
  .object({
    search: z.string().trim().max(100).optional(),
    cursor: identifier.optional(),
  })
  .strict();
function parse<T>(schema: z.ZodType<T>, input: unknown) {
  const result = schema.safeParse(input);
  if (!result.success)
    throw new AdminError(400, 'Invalid request. Check the supplied fields.');
  return result.data;
}
const userFields = `u.id,u.name,u.email,u.role,u.email_verified AS "emailVerified",u.suspended,
 u.admin_revision AS revision,u.created_at AS "createdAt",
 (SELECT count(*)::int FROM mail_accounts a WHERE a.user_id=u.id) AS "accountCount",
 (SELECT count(*)::int FROM auth_sessions s WHERE s.user_id=u.id AND s.expires_at>clock_timestamp()) AS "sessionCount"`;
const inviteFields = `id,email,role,expires_at AS "expiresAt",created_at AS "createdAt",delivery_state AS delivery,
 CASE WHEN accepted_at IS NOT NULL THEN 'accepted' WHEN revoked_at IS NOT NULL THEN 'revoked'
 WHEN expires_at<=clock_timestamp() THEN 'expired' ELSE 'pending' END AS status`;

export function registerAdminRoutes(
  app: FastifyInstance,
  pool: Pool,
  auth: Auth,
  config: AuthConfig,
  mailer: Transporter,
) {
  const actorForRequest = new WeakMap<
    FastifyRequest,
    { id: string; session: string }
  >();
  app.setErrorHandler(
    (error: Error & { statusCode?: number }, request, reply) => {
      if (error instanceof AdminError)
        return reply.code(error.statusCode).send({
          message: error.message,
          ...(error.code ? { code: error.code } : {}),
        });
      if (error.statusCode && error.statusCode >= 400 && error.statusCode < 500)
        return reply
          .code(error.statusCode)
          .send({ message: 'Invalid administration request.' });
      request.log.error('Administration request failed');
      return reply.code(500).send({
        message: 'Administration is temporarily unavailable. Try again.',
      });
    },
  );
  app.addHook('preHandler', async (request, reply) => {
    reply.header('cache-control', 'no-store');
    if (request.method !== 'GET' && request.headers.origin !== config.appUrl)
      throw new AdminError(403, 'Request origin is not allowed.');
    const current = await auth.api.getSession({
      headers: authHeaders(request),
    });
    if (!current) throw new AdminError(401, 'Sign in to continue.');
    if (
      !current.user.emailVerified ||
      current.user.suspended ||
      current.user.role !== 'admin'
    )
      throw new AdminError(403, 'Administrator access is required.');
    actorForRequest.set(request, {
      id: current.user.id,
      session: current.session.id,
    });
    if (
      !(await consumeLimit(
        pool,
        current.user.id,
        request.method === 'GET' ? 'admin-read' : 'admin-write',
        request.method === 'GET' ? 120 : 10,
      ))
    )
      throw new AdminError(
        429,
        'Too many administration requests. Try again in a minute.',
      );

    if (
      !['/api/admin/access', '/api/admin/unlock'].includes(
        request.routeOptions.url ?? '',
      )
    ) {
      const currentActor = actorForRequest.get(request);
      const active = (
        await pool.query(
          'SELECT admin_unlocked_at FROM auth_sessions WHERE id=$1 AND user_id=$2 AND expires_at>clock_timestamp()',
          [currentActor?.session, currentActor?.id],
        )
      ).rows[0];
      if (!active) throw new AdminError(401, 'Sign in to continue.');
      if (!active.admin_unlocked_at)
        throw new AdminError(
          403,
          'Unlock administration to continue.',
          'ADMIN_LOCKED',
        );
    }
  });

  async function adminTransaction<T>(
    request: FastifyRequest,
    confirmedHash: string | null,
    work: (client: PoolClient, actor: string) => Promise<T>,
  ) {
    const current = actorForRequest.get(request);
    if (!current) throw new AdminError(401, 'Sign in to continue.');
    return transaction(pool, async (client) => {
      await client.query('SELECT pg_advisory_xact_lock(728491603)');
      const actor = (
        await client.query(
          'SELECT id,role,suspended,email_verified FROM users WHERE id=$1 FOR UPDATE',
          [current.id],
        )
      ).rows[0];
      if (actor?.role !== 'admin' || actor.suspended || !actor.email_verified)
        throw new AdminError(403, 'Administrator access is required.');
      if (confirmedHash) {
        const credential = (
          await client.query(
            "SELECT password FROM auth_accounts WHERE user_id=$1 AND provider_id='credential' FOR UPDATE",
            [current.id],
          )
        ).rows[0];
        if (credential?.password !== confirmedHash)
          throw new AdminError(401, 'Your account changed. Sign in again.');
      }
      const active = (
        await client.query(
          'SELECT admin_unlocked_at FROM auth_sessions WHERE id=$1 AND user_id=$2 AND expires_at>clock_timestamp() FOR UPDATE',
          [current.session, current.id],
        )
      ).rows[0];
      if (!active)
        throw new AdminError(401, 'Your account changed. Sign in again.');
      if (!confirmedHash && !active.admin_unlocked_at)
        throw new AdminError(
          403,
          'Unlock administration to continue.',
          'ADMIN_LOCKED',
        );
      return work(client, current.id);
    });
  }
  app.get('/api/admin/access', async (request) => {
    parse(z.object({}).strict(), request.query);
    const actor = actorForRequest.get(request);
    const active = (
      await pool.query(
        'SELECT admin_unlocked_at IS NOT NULL AS unlocked FROM auth_sessions WHERE id=$1 AND user_id=$2 AND expires_at>clock_timestamp()',
        [actor?.session, actor?.id],
      )
    ).rows[0];
    if (!active) throw new AdminError(401, 'Sign in to continue.');
    return { unlocked: active.unlocked };
  });
  app.post('/api/admin/unlock', async (request) => {
    const body = parse(
      z.object({ currentPassword: z.string().min(1).max(128) }).strict(),
      request.body,
    );
    const actor = actorForRequest.get(request);
    if (!actor) throw new AdminError(401, 'Sign in to continue.');
    if (!(await consumeLimit(pool, actor.id, 'admin-confirm', 5)))
      throw new AdminError(
        429,
        'Too many password confirmations. Try again in a minute.',
      );
    const context = await auth.$context;
    const credential = await context.internalAdapter.findCredentialAccount(
      actor.id,
    );
    const hash = credential?.password;
    if (
      !hash ||
      !(await context.password.verify({ hash, password: body.currentPassword }))
    )
      throw new AdminError(400, 'Your current password is incorrect.');
    await adminTransaction(request, hash, async (client) => {
      await client.query(
        'UPDATE auth_sessions SET admin_unlocked_at=coalesce(admin_unlocked_at,clock_timestamp()) WHERE id=$1 AND user_id=$2',
        [actor.session, actor.id],
      );
    });
    return { unlocked: true };
  });

  async function mutate(
    request: FastifyRequest,
    body: { operationId: string },
    action: string,
    target: string,
    intent: object,
    work: (client: PoolClient, actor: string) => Promise<object>,
  ) {
    const current = actorForRequest.get(request);
    if (!current) throw new AdminError(401, 'Sign in to continue.');
    const requestHash = createHash('sha256')
      .update(JSON.stringify({ action, target, intent }))
      .digest('hex');
    return adminTransaction(request, null, async (client) => {
      const replay = (
        await client.query(
          'SELECT actor_id,request_hash,details FROM admin_audit WHERE id=$1',
          [body.operationId],
        )
      ).rows[0];
      if (replay) {
        if (
          replay.actor_id !== current.id ||
          replay.request_hash !== requestHash
        )
          throw new AdminError(
            409,
            'This operation ID was already used. Refresh and try again.',
          );
        return { ...replay.details, replayed: true };
      }
      const details = await work(client, current.id);
      await client.query(
        'INSERT INTO admin_audit(id,actor_id,action,target_id,request_hash,details) VALUES($1,$2,$3,$4,$5,$6)',
        [
          body.operationId,
          current.id,
          action,
          target,
          requestHash,
          JSON.stringify(details),
        ],
      );
      return { ...details, replayed: false };
    });
  }

  app.get('/api/admin/overview', async (request) => {
    parse(z.object({}).strict(), request.query);
    return (
      await pool.query(`SELECT (SELECT count(*)::int FROM users) AS users,
      (SELECT count(*)::int FROM users WHERE suspended) AS suspended,
      (SELECT count(*)::int FROM invites WHERE accepted_at IS NULL AND revoked_at IS NULL AND expires_at>clock_timestamp()) AS invitations`)
    ).rows[0];
  });
  app.get('/api/admin/users', async (request) => {
    const query = parse(listing, request.query);
    const search = `%${(query.search ?? '').replace(/[\\%_]/g, '\\$&')}%`;
    const rows = (
      await pool.query(
        `SELECT ${userFields},u.id=$3 AS current FROM users u WHERE (u.email ILIKE $1 OR u.name ILIKE $1)
      AND ($2::text IS NULL OR u.id>$2) ORDER BY u.id LIMIT 26`,
        [search, query.cursor ?? null, actorForRequest.get(request)?.id],
      )
    ).rows;
    return {
      users: rows.slice(0, 25),
      nextCursor: rows.length > 25 ? rows[24].id : null,
    };
  });
  app.get('/api/admin/invites', async (request) => {
    const query = parse(listing, request.query);
    const search = `%${(query.search ?? '').replace(/[\\%_]/g, '\\$&')}%`;
    const rows = (
      await pool.query(
        `SELECT ${inviteFields} FROM invites WHERE email ILIKE $1 AND ($2::text IS NULL OR id>$2) ORDER BY id LIMIT 26`,
        [search, query.cursor ?? null],
      )
    ).rows;
    return {
      invites: rows.slice(0, 25),
      nextCursor: rows.length > 25 ? rows[24].id : null,
    };
  });
  app.get('/api/admin/audit', async (request) => {
    const query = parse(
      z.object({ cursor: z.uuid().optional() }).strict(),
      request.query,
    );
    if (
      query.cursor &&
      !(
        await pool.query('SELECT 1 FROM admin_audit WHERE id=$1', [
          query.cursor,
        ])
      ).rowCount
    )
      throw new AdminError(
        409,
        'The activity list changed. Refresh and try again.',
      );
    const rows = (
      await pool.query(
        `SELECT a.id,a.action,a.target_id AS "targetId",a.details,a.created_at AS "createdAt",u.email AS "actorEmail"
      FROM admin_audit a LEFT JOIN users u ON u.id=a.actor_id
      WHERE ($1::uuid IS NULL OR (a.created_at,a.id)<(SELECT created_at,id FROM admin_audit WHERE id=$1))
      ORDER BY a.created_at DESC,a.id DESC LIMIT 26`,
        [query.cursor ?? null],
      )
    ).rows;
    return {
      events: rows.slice(0, 25),
      nextCursor: rows.length > 25 ? rows[24].id : null,
    };
  });
  app.post('/api/admin/users/:id', async (request) => {
    const { id } = parse(z.object({ id: identifier }).strict(), request.params);
    const body = parse(userAction, request.body);
    if ((body.action === 'role') !== (body.role !== undefined))
      throw new AdminError(400, 'Choose a role only for a role change.');
    const intent = {
      expectedRevision: body.expectedRevision,
      ...(body.role ? { role: body.role } : {}),
    };
    const result = await mutate(
      request,
      body,
      `user.${body.action}`,
      id,
      intent,
      async (client, actor) => {
        if (id === actor)
          throw new AdminError(
            400,
            'Use another administrator to change your access or revoke your sessions.',
          );
        const target = (
          await client.query(
            'SELECT id,email,role,suspended,admin_revision FROM users WHERE id=$1 FOR UPDATE',
            [id],
          )
        ).rows[0];
        if (!target) throw new AdminError(404, 'User not found.');
        if (target.admin_revision !== body.expectedRevision)
          throw new AdminError(
            409,
            'This user changed. Refresh before trying again.',
          );
        const suspended =
          body.action === 'suspend'
            ? true
            : body.action === 'resume'
              ? false
              : target.suspended;
        const role = body.role ?? target.role;
        if (
          target.role === 'admin' &&
          !target.suspended &&
          (suspended || role !== 'admin') &&
          !(
            await client.query(
              "SELECT 1 FROM users WHERE role='admin' AND NOT suspended AND id<>$1",
              [id],
            )
          ).rowCount
        )
          throw new AdminError(
            409,
            'The last active administrator must remain enabled.',
          );
        await client.query(
          'UPDATE users SET role=$2,suspended=$3,admin_revision=admin_revision+1,updated_at=clock_timestamp() WHERE id=$1',
          [id, role, suspended],
        );
        if (body.action === 'sessions' || body.action === 'role')
          await client.query('DELETE FROM auth_sessions WHERE user_id=$1', [
            id,
          ]);
        return { email: target.email, role, suspended };
      },
    );
    return { status: true, ...result };
  });
  app.post('/api/admin/invites', async (request) => {
    const body = parse(inviteAction, request.body);
    const result = await mutate(
      request,
      body,
      'invite.send',
      body.email,
      { expectedId: body.expectedId },
      async (client) => {
        if (
          (
            await client.query('SELECT 1 FROM users WHERE email=$1', [
              body.email,
            ])
          ).rowCount
        )
          throw new AdminError(409, 'This address already has an account.');
        const previous = (
          await client.query(
            'SELECT id,role FROM invites WHERE email=$1 FOR UPDATE',
            [body.email],
          )
        ).rows[0];
        if ((previous?.id ?? null) !== body.expectedId)
          throw new AdminError(
            409,
            'This invitation changed. Refresh before trying again.',
          );
        if (previous?.role === 'admin')
          throw new AdminError(
            409,
            'Initial administrator invitations are managed by the operator command.',
          );
        const invite = await saveInvitation(client, body.email, 'user');
        return {
          inviteId: invite.id,
          email: invite.email,
          expiresAt: invite.expires_at.toISOString(),
        };
      },
    );
    // A replay never sends a second email after a lost HTTP response.
    if (!result.replayed) {
      const delivered = await deliverInvitation(pool, mailer, config, {
        id: String(result.inviteId),
        email: body.email,
        expires_at: new Date(String(result.expiresAt)),
      });
      return { status: true, delivery: delivered, ...result };
    }
    return { status: true, ...result };
  });
  app.post('/api/admin/invites/revoke', async (request) => {
    const body = parse(revokeInvite, request.body);
    const result = await mutate(
      request,
      body,
      'invite.revoke',
      body.inviteId,
      {},
      async (client) => {
        const invite = (
          await client.query(
            'SELECT id,email,accepted_at,role FROM invites WHERE id=$1 FOR UPDATE',
            [body.inviteId],
          )
        ).rows[0];
        if (!invite)
          throw new AdminError(
            409,
            'This invitation changed. Refresh before trying again.',
          );
        if (invite.accepted_at)
          throw new AdminError(
            409,
            'This invitation was accepted. Manage the user instead.',
          );
        if (invite.role === 'admin')
          throw new AdminError(
            409,
            'Initial administrator invitations are managed by the operator command.',
          );
        await client.query(
          'UPDATE invites SET revoked_at=clock_timestamp() WHERE id=$1',
          [body.inviteId],
        );
        return { email: invite.email };
      },
    );
    return { status: true, ...result };
  });
}
