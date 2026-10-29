// User-requested fetches and mail actions take priority over another metadata pass.
export const contentPending = `SELECT 1 FROM mail_content WHERE user_id=$1 AND account_id=$2 AND (state='pending' OR reply_headers_pending)
  UNION ALL SELECT 1 FROM mail_content_attachments WHERE user_id=$1 AND account_id=$2 AND state='pending'
  UNION ALL SELECT 1 FROM mail_actions WHERE user_id=$1 AND account_id=$2 AND state='pending'
  UNION ALL SELECT 1 FROM mail_outbox WHERE user_id=$1 AND account_id=$2 AND state IN ('queued','sending') LIMIT 1`;
