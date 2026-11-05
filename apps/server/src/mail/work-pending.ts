// User-requested fetches and mail actions take priority over another metadata pass.
export const contentPending = `SELECT 1 FROM mail_content WHERE user_id=$1 AND account_id=$2 AND (state='pending' OR reply_headers_pending)
  UNION ALL SELECT 1 FROM mail_content_attachments WHERE user_id=$1 AND account_id=$2 AND state='pending'
  UNION ALL SELECT 1 FROM mail_actions WHERE user_id=$1 AND account_id=$2 AND state='pending'
  UNION ALL SELECT 1 FROM mail_outbox WHERE user_id=$1 AND account_id=$2 AND (state='sending' OR (state='queued' AND (scheduled_at IS NULL OR scheduled_at<=clock_timestamp()))) LIMIT 1`;

// A reader waiting on a body or attachment: running metadata jobs stop at
// their next batch boundary (D041). Actions are excluded because they sit in
// a five-second undo window and are scheduled, not awaited.
export const bodyPending = `SELECT 1 FROM mail_content WHERE user_id=$1 AND account_id=$2 AND (state='pending' OR reply_headers_pending)
  UNION ALL SELECT 1 FROM mail_content_attachments WHERE user_id=$1 AND account_id=$2 AND state='pending' LIMIT 1`;
