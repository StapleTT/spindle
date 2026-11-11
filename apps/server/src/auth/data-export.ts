import { once } from 'node:events';
import type { Writable } from 'node:stream';
import { createGzip } from 'node:zlib';
import type { FastifyInstance } from 'fastify';
import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import { consumeLimit } from '../mail/store.js';
import { insertSecurityEvent } from './account-lifecycle.js';
import type { Auth } from './auth.js';
import type { AuthConfig } from './config.js';
import { authHeaders } from './routes.js';

// Explicit columns only: credentials, tokens, leases and cached bodies never enter an export.
// Each query yields one JSON text column `j` and takes the owner as $1.
const base64 = (bytes: string) =>
  `translate(encode(${bytes},'base64'),E'\\n','')`;
const sections: [
  name: string,
  kind: 'object' | 'array',
  batch: number,
  sql: string,
][] = [
  [
    'profile',
    'object',
    1,
    `SELECT json_build_object('id',id,'name',name,'email',email,'role',role,'createdAt',created_at)::text j
     FROM users WHERE id=$1`,
  ],
  [
    'preferences',
    'object',
    1,
    `SELECT json_build_object('imageProxy',image_proxy,'blockRemoteImages',block_remote_images,'undoSend',undo_send)::text j
     FROM mail_preferences WHERE user_id=$1`,
  ],
  [
    'accounts',
    'array',
    100,
    `SELECT json_build_object('id',a.id,'name',a.name,'color',a.color,'provider',a.provider,'host',a.host,'port',a.port,'transport',a.transport,
      'username',a.username,'providerName',a.provider_name,'status',a.status,'historySince',a.history_since,'lastSyncedAt',a.last_synced_at,
      'createdAt',a.created_at,'sortOrder',a.sort_order,
      'smtp',(SELECT json_build_object('host',s.host,'port',s.port,'transport',s.transport,'username',s.username,
        'displayName',s.display_name,'saveSentCopy',s.save_sent_copy) FROM mail_smtp s WHERE s.user_id=a.user_id AND s.account_id=a.id),
      'signature',(SELECT json_build_object('html',g.html,'text',g.text,'newMessages',g.new_messages,
        'repliesForwards',g.replies_forwards) FROM mail_signatures g WHERE g.user_id=a.user_id AND g.account_id=a.id))::text j
     FROM mail_accounts a WHERE a.user_id=$1 ORDER BY a.sort_order,a.created_at,a.id`,
  ],
  [
    'folders',
    'array',
    500,
    `SELECT json_build_object('id',id,'accountId',account_id,'path',path,'name',name,'role',role)::text j
     FROM mailboxes WHERE user_id=$1 ORDER BY account_id,path`,
  ],
  [
    'messages',
    'array',
    500,
    `SELECT json_build_object('id',m.id,'accountId',m.account_id,'messageId',m.message_id,'subject',m.subject,
      'from',m.sender,'recipients',m.recipients,'sentAt',m.sent_at,'receivedAt',m.received_at,'inReplyTo',m.in_reply_to,
      'references',m.reference_ids,'sizeBytes',m.size_bytes,'pinned',m.local_pinned,'muted',m.local_muted,
      'snoozedUntil',m.local_snoozed_until,'needsReply',m.local_needs_reply,
      'folders',(SELECT coalesce(json_agg(json_build_object('folderId',mm.mailbox_id,'flags',mm.flags)),'[]')
        FROM mail_memberships mm WHERE mm.user_id=m.user_id AND mm.message_id=m.id))::text j
     FROM mail_messages m WHERE m.user_id=$1 ORDER BY m.received_at,m.id`,
  ],
  [
    'drafts',
    'array',
    1,
    `SELECT json_build_object('id',d.id,'accountId',d.account_id,'content',d.content,'replyContext',d.reply_context,
      'forwardContent',d.forward_content,'createdAt',d.created_at,'updatedAt',d.updated_at,
      'attachments',(SELECT coalesce(json_agg(json_build_object('filename',f.filename,'sizeBytes',f.size_bytes,
        'base64',(SELECT ${base64("string_agg(c.data,''::bytea ORDER BY c.position)")} FROM mail_upload_chunks c
          WHERE c.user_id=f.user_id AND c.file_id=f.id)) ORDER BY da.position),'[]')
        FROM mail_draft_attachments da JOIN mail_uploads f ON f.user_id=da.user_id AND f.id=da.file_id
        WHERE da.user_id=d.user_id AND da.draft_id=d.id AND f.state='ready'))::text j
     FROM mail_drafts d WHERE d.user_id=$1 ORDER BY d.created_at,d.id`,
  ],
  [
    'outbox',
    'array',
    1,
    `SELECT json_build_object('id',o.id,'accountId',o.account_id,'sender',o.sender,'recipients',o.recipients,
      'subject',o.subject,'messageId',o.message_id,'state',o.state,'accepted',o.accepted,'rejected',o.rejected,
      'errorCode',o.error_code,'createdAt',o.created_at,'scheduledAt',o.scheduled_at,'completedAt',o.completed_at,
      'sentCopy',o.sent_copy,'mimeBase64',${base64(
        `coalesce(o.raw,(SELECT string_agg(c.data,''::bytea ORDER BY c.position) FROM mail_outbox_chunks c
          WHERE c.user_id=o.user_id AND c.outbox_id=o.id))`,
      )})::text j
     FROM mail_outbox o WHERE o.user_id=$1 ORDER BY o.created_at,o.id`,
  ],
  [
    'savedSearches',
    'array',
    100,
    `SELECT json_build_object('name',name,'query',query,'accountId',account_id,'folderId',mailbox_id,'createdAt',created_at)::text j
     FROM mail_saved_searches WHERE user_id=$1 ORDER BY created_at,id`,
  ],
  [
    'securityActivity',
    'array',
    500,
    `SELECT json_build_object('type',type,'ipAddress',ip_address,'userAgent',user_agent,'createdAt',created_at)::text j
     FROM security_events WHERE user_id=$1 ORDER BY created_at,id`,
  ],
];

export async function writeExport(
  client: PoolClient,
  userId: string,
  out: Writable,
) {
  const write = async (text: string) => {
    if (!out.write(text)) await once(out, 'drain');
  };
  // One snapshot for every section; cursors keep memory bounded per batch.
  await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  try {
    await write(
      `{"format":"spindle-export","version":1,"exportedAt":${JSON.stringify(new Date())}`,
    );
    for (const [name, kind, batch, sql] of sections) {
      await client.query(`DECLARE export_rows NO SCROLL CURSOR FOR ${sql}`, [
        userId,
      ]);
      await write(`,"${name}":${kind === 'array' ? '[' : ''}`);
      let count = 0;
      for (;;) {
        const { rows } = await client.query<{ j: string }>(
          `FETCH ${batch} FROM export_rows`,
        );
        for (const row of rows) await write((count++ ? ',' : '') + row.j);
        if (rows.length < batch) break;
      }
      await write(kind === 'array' ? ']' : count ? '' : 'null');
      await client.query('CLOSE export_rows');
    }
    await write('}');
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  }
}

export function registerDataExport(
  app: FastifyInstance,
  pool: Pool,
  auth: Auth,
  config: AuthConfig,
) {
  app.post(
    '/api/account/export',
    { bodyLimit: 4096 },
    async (request, reply) => {
      reply.header('cache-control', 'no-store');
      if (request.headers.origin !== config.appUrl)
        return reply
          .code(403)
          .send({ message: 'Request origin is not allowed.' });
      const headers = authHeaders(request);
      const current = await auth.api.getSession({ headers });
      if (!current)
        return reply.code(401).send({ message: 'Sign in to continue.' });
      if (!current.user.emailVerified || current.user.suspended)
        return reply
          .code(403)
          .send({ message: 'Verify your email to continue.' });
      const body = z
        .object({ currentPassword: z.string().min(1).max(128) })
        .strict()
        .safeParse(request.body);
      if (!body.success)
        return reply
          .code(400)
          .send({ message: 'Enter your current password.' });
      if (!(await consumeLimit(pool, current.user.id, 'account-export', 2)))
        return reply.code(429).send({
          message: 'Too many export requests. Try again in a minute.',
        });
      const context = await auth.$context;
      const credential = await context.internalAdapter.findCredentialAccount(
        current.user.id,
      );
      if (
        !credential?.password ||
        !(await context.password.verify({
          hash: credential.password,
          password: body.data.currentPassword,
        }))
      )
        return reply
          .code(400)
          .send({ message: 'Your current password is incorrect.' });
      await insertSecurityEvent(
        pool,
        current.user.id,
        'export.created',
        headers,
      );
      const client = await pool.connect();
      const gzip = createGzip();
      // A disconnected download must not leave the snapshot transaction waiting for drain.
      reply.raw.on('close', () => {
        if (!gzip.writableFinished) gzip.destroy(new Error('Export aborted'));
      });
      writeExport(client, current.user.id, gzip).then(
        () => {
          gzip.end();
          client.release();
        },
        (error: Error) => {
          if (error.message !== 'Export aborted')
            request.log.error('Data export failed');
          gzip.destroy(error);
          client.release(true);
        },
      );
      const day = new Date().toISOString().slice(0, 10);
      return reply
        .header('content-type', 'application/gzip')
        .header(
          'content-disposition',
          `attachment; filename="spindle-export-${day}.json.gz"`,
        )
        .send(gzip);
    },
  );
}
