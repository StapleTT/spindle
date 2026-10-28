import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import {
  adoptProviderValue,
  type Candidate,
  providerDraftErrors,
} from './provider-drafts.js';
import { transaction } from './store.js';

export const draftSyncField = `COALESCE((SELECT jsonb_agg(jsonb_build_object('id',p.id,'accountId',p.account_id,'state',p.state,'code',p.error_code,'hasProviderVersion',p.candidate IS NOT NULL) ORDER BY p.id)
  FROM mail_draft_links p WHERE p.user_id=mail_drafts.user_id AND p.source_draft_id=mail_drafts.id AND p.state<>'removed'),'[]') AS "providerSync"`;

export function registerProviderDraftRoutes(app: FastifyInstance, pool: Pool) {
  app.get<{ Params: { id: string } }>(
    '/api/mail/draft-sync/:id/version',
    {
      schema: {
        params: {
          type: 'object',
          properties: { id: { type: 'string', format: 'uuid' } },
          required: ['id'],
          additionalProperties: false,
        },
      },
    },
    async (request, reply) => {
      const row = (
        await pool.query(
          'SELECT candidate FROM mail_draft_links WHERE user_id=$1 AND id=$2',
          [request.mailUser, request.params.id],
        )
      ).rows[0];
      if (!row?.candidate)
        return reply
          .code(404)
          .send({ message: 'Provider version not available.' });
      const candidate = row.candidate as Candidate;
      return {
        subject: candidate.content.subject,
        text: candidate.content.text || candidate.forward?.text || '',
        attachments: candidate.attachmentIds.length,
      };
    },
  );
  app.get('/api/mail/draft-sync', async (request) => ({
    issues: [
      ...(
        await pool.query(
          `SELECT p.id,p.draft_id AS "draftId",p.subject,p.state,p.error_code AS code,a.name AS "accountName",false AS import
      FROM mail_draft_links p JOIN mail_accounts a ON a.user_id=p.user_id AND a.id=p.account_id WHERE p.user_id=$1 AND p.state IN ('conflict','unknown','failed') ORDER BY p.next_attempt_at LIMIT 100`,
          [request.mailUser],
        )
      ).rows,
      ...(
        await pool.query(
          `SELECT p.id,NULL AS "draftId",p.subject,p.state,p.error_code AS code,a.name AS "accountName",true AS import
      FROM mail_draft_imports p JOIN mail_accounts a ON a.user_id=p.user_id AND a.id=p.account_id WHERE p.user_id=$1 AND p.state='failed' ORDER BY p.next_attempt_at LIMIT 100`,
          [request.mailUser],
        )
      ).rows,
    ].map((issue) => ({
      ...issue,
      message:
        providerDraftErrors[issue.code] ??
        'Provider draft sync needs attention.',
    })),
  }));
  app.post<{
    Params: { id: string };
    Body: {
      action: 'retry' | 'useProvider' | 'keepLocal' | 'leaveProvider';
      revision?: number;
      import?: boolean;
    };
  }>(
    '/api/mail/draft-sync/:id',
    {
      schema: {
        params: {
          type: 'object',
          required: ['id'],
          properties: { id: { type: 'string', format: 'uuid' } },
          additionalProperties: false,
        },
        body: {
          type: 'object',
          required: ['action'],
          additionalProperties: false,
          properties: {
            action: {
              type: 'string',
              enum: ['retry', 'useProvider', 'keepLocal', 'leaveProvider'],
            },
            revision: { type: 'integer', minimum: 1 },
            import: { type: 'boolean' },
          },
        },
      },
    },
    async (request, reply) => {
      const owner = request.mailUser ?? '',
        { action, revision } = request.body;
      const result = await transaction(pool, async (db) => {
        await db.query('SELECT id FROM users WHERE id=$1 FOR UPDATE', [owner]);
        if (request.body.import) {
          if (action !== 'retry') return 'refused';
          const changed = await db.query(
            "UPDATE mail_draft_imports SET state='pending',error_code=NULL,next_attempt_at=clock_timestamp() WHERE user_id=$1 AND id=$2 AND state='failed' RETURNING id",
            [owner, request.params.id],
          );
          return changed.rowCount ? 'ok' : 'missing';
        }
        const link = (
          await db.query(
            'SELECT * FROM mail_draft_links WHERE user_id=$1 AND id=$2 FOR UPDATE',
            [owner, request.params.id],
          )
        ).rows[0];
        if (!link) return 'missing';
        const draft = link.draft_id
          ? (
              await db.query(
                'SELECT id,revision,account_id FROM mail_drafts WHERE user_id=$1 AND id=$2 FOR UPDATE',
                [owner, link.draft_id],
              )
            ).rows[0]
          : null;
        if (action === 'retry') {
          if (
            !['failed', 'waiting', 'unknown', 'pending', 'synced'].includes(
              link.state,
            )
          )
            return 'refused';
          await db.query(
            "UPDATE mail_draft_links SET state='pending',attempts=0,next_attempt_at=clock_timestamp() WHERE user_id=$1 AND id=$2",
            [owner, link.id],
          );
          return 'ok';
        }
        if (action === 'leaveProvider') {
          if (
            draft?.account_id === link.account_id ||
            !['conflict', 'unknown', 'failed'].includes(link.state)
          )
            return 'refused';
          await db.query(
            "UPDATE mail_draft_copies SET state='kept' WHERE user_id=$1 AND link_id=$2 AND state<>'removed'",
            [owner, link.id],
          );
          await db.query(
            "UPDATE mail_draft_links SET state='removed',candidate=NULL,error_code=NULL WHERE user_id=$1 AND id=$2",
            [owner, link.id],
          );
          await db.query(
            'DELETE FROM mail_draft_conflict_files WHERE user_id=$1 AND link_id=$2',
            [owner, link.id],
          );
          return 'ok';
        }
        if (
          !draft ||
          draft.account_id !== link.account_id ||
          draft.revision !== revision ||
          link.state !== 'conflict' ||
          (
            await db.query(
              "SELECT 1 FROM mail_outbox WHERE user_id=$1 AND draft_id=$2 AND state NOT IN ('failed','cancelled') LIMIT 1",
              [owner, draft.id],
            )
          ).rowCount
        )
          return 'refused';
        if (action === 'useProvider') {
          const candidate = link.candidate as Candidate | null;
          if (!candidate) return 'refused';
          await db.query(
            "UPDATE mail_draft_copies SET state='obsolete' WHERE user_id=$1 AND link_id=$2 AND state='active' AND id<>$3",
            [owner, link.id, candidate.copy.id],
          );
          await db.query(
            "UPDATE mail_draft_copies SET state='active',uid=$3,uid_validity=$4,hash=$5,size_bytes=$6,modseq=$7 WHERE user_id=$1 AND id=$2",
            [
              owner,
              candidate.copy.id,
              candidate.copy.uid,
              candidate.copy.uid_validity,
              candidate.copy.hash,
              candidate.copy.size_bytes,
              candidate.copy.modseq,
            ],
          );
          const next = await adoptProviderValue(db, owner, draft.id, candidate);
          await db.query(
            "UPDATE mail_draft_links SET active_copy_id=$3,synced_revision=$4,desired_revision=$4,state='pending',candidate=NULL,error_code=NULL,next_attempt_at=clock_timestamp() WHERE user_id=$1 AND id=$2",
            [owner, link.id, candidate.copy.id, next],
          );
        } else {
          // Preserve the provider's independently edited version as a separate draft.
          await db.query(
            "UPDATE mail_draft_copies SET state='kept' WHERE user_id=$1 AND link_id=$2 AND state IN ('active','obsolete')",
            [owner, link.id],
          );
          await db.query(
            "UPDATE mail_draft_links SET active_copy_id=NULL,synced_revision=0,state='pending',candidate=NULL,error_code=NULL,next_attempt_at=clock_timestamp() WHERE user_id=$1 AND id=$2",
            [owner, link.id],
          );
        }
        await db.query(
          'DELETE FROM mail_draft_conflict_files WHERE user_id=$1 AND link_id=$2',
          [owner, link.id],
        );
        return 'ok';
      });
      if (result === 'missing')
        return reply.code(404).send({ message: 'Provider draft not found.' });
      if (result === 'refused')
        return reply.code(409).send({
          message:
            'This draft changed or is frozen in Outbox. Reload and review both versions.',
        });
      return { updated: true };
    },
  );
}
