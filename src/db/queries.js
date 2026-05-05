// node:sqlite is built into Node 22.5+ — no npm package needed
const db = require('./schema');

// --- Users ---

const getUserById = db.prepare(`SELECT * FROM users WHERE id = ?`);
const getUserByUsername = db.prepare(`SELECT * FROM users WHERE username = ?`);
const countUsers = db.prepare(`SELECT COUNT(*) AS count FROM users`);
const insertUser = db.prepare(`
  INSERT INTO users (username, password_hash, recovery_email, role, invite_code_used)
  VALUES (@username, @password_hash, @recovery_email, @role, @invite_code_used)
`);
const updateUserTheme = db.prepare(`UPDATE users SET theme = ? WHERE id = ?`);
const updateUserPassword = db.prepare(`UPDATE users SET password_hash = ? WHERE id = ?`);
const deleteUser = db.prepare(`DELETE FROM users WHERE id = ?`);
const getAllUsers = db.prepare(`
  SELECT id, username, role, theme, invite_code_used, created_at FROM users ORDER BY id
`);

// --- Invite Codes ---

const getInviteCode = db.prepare(`SELECT * FROM invite_codes WHERE code = ?`);
const getInviteCodeByCode = db.prepare(`
  SELECT ic.*, u.username AS used_by_username
  FROM invite_codes ic
  LEFT JOIN users u ON ic.used_by = u.id
  WHERE ic.code = ?
`);
const getAllInviteCodes = db.prepare(`
  SELECT ic.*, creator.username AS created_by_username, used.username AS used_by_username
  FROM invite_codes ic
  LEFT JOIN users creator ON ic.created_by = creator.id
  LEFT JOIN users used ON ic.used_by = used.id
  ORDER BY ic.created_at DESC
`);
const insertInviteCode = db.prepare(`
  INSERT INTO invite_codes (code, created_by) VALUES (@code, @created_by)
`);
const markInviteCodeUsed = db.prepare(`
  UPDATE invite_codes SET used_by = @used_by WHERE code = @code
`);
const revokeInviteCode = db.prepare(`
  UPDATE invite_codes SET revoked = 1 WHERE code = ?
`);

// --- Email Accounts ---

const getEmailAccountsByUser = db.prepare(`
  SELECT id, user_id, display_name, email_address, provider, sort_order,
         imap_host, imap_port, imap_secure, smtp_host, smtp_port, smtp_secure,
         imap_user, created_at
  FROM email_accounts
  WHERE user_id = ?
  ORDER BY sort_order, id
`);
const getEmailAccountById = db.prepare(`SELECT * FROM email_accounts WHERE id = ?`);
const insertEmailAccount = db.prepare(`
  INSERT INTO email_accounts
    (user_id, display_name, email_address, provider, sort_order,
     imap_host, imap_port, imap_secure, smtp_host, smtp_port, smtp_secure,
     imap_user, imap_password_encrypted, oauth_access_token, oauth_refresh_token, oauth_token_expiry)
  VALUES
    (@user_id, @display_name, @email_address, @provider, @sort_order,
     @imap_host, @imap_port, @imap_secure, @smtp_host, @smtp_port, @smtp_secure,
     @imap_user, @imap_password_encrypted, @oauth_access_token, @oauth_refresh_token, @oauth_token_expiry)
`);
const deleteEmailAccount = db.prepare(`DELETE FROM email_accounts WHERE id = ? AND user_id = ?`);
const updateEmailAccountSortOrder = db.prepare(`
  UPDATE email_accounts SET sort_order = @sort_order WHERE id = @id AND user_id = @user_id
`);
const updateOAuthTokens = db.prepare(`
  UPDATE email_accounts
  SET oauth_access_token = @oauth_access_token,
      oauth_refresh_token = @oauth_refresh_token,
      oauth_token_expiry = @oauth_token_expiry
  WHERE id = @id
`);

// --- Recovery Tokens ---

const insertRecoveryToken = db.prepare(`
  INSERT INTO recovery_tokens (user_id, token_hash, expires_at)
  VALUES (@user_id, @token_hash, @expires_at)
`);
const getValidRecoveryToken = db.prepare(`
  SELECT * FROM recovery_tokens
  WHERE token_hash = ? AND used = 0 AND expires_at > datetime('now')
`);
const markRecoveryTokenUsed = db.prepare(`
  UPDATE recovery_tokens SET used = 1 WHERE id = ?
`);
const getUserByRecoveryEmail = db.prepare(`
  SELECT * FROM users WHERE username = ? AND LOWER(recovery_email) = LOWER(?)
`);

module.exports = {
  // Users
  getUserById,
  getUserByUsername,
  countUsers,
  insertUser,
  updateUserTheme,
  updateUserPassword,
  deleteUser,
  getAllUsers,

  // Invite Codes
  getInviteCode,
  getInviteCodeByCode,
  getAllInviteCodes,
  insertInviteCode,
  markInviteCodeUsed,
  revokeInviteCode,

  // Email Accounts
  getEmailAccountsByUser,
  getEmailAccountById,
  insertEmailAccount,
  deleteEmailAccount,
  updateEmailAccountSortOrder,
  updateOAuthTokens,

  // Recovery Tokens
  insertRecoveryToken,
  getValidRecoveryToken,
  markRecoveryTokenUsed,
  getUserByRecoveryEmail,
};
