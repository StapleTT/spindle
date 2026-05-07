const nodemailer = require('nodemailer');
const { decrypt } = require('../utils/crypto');

/**
 * Build a nodemailer transporter from a stored IMAP/SMTP account.
 * Password is AES-256-GCM encrypted in the database; decrypt before use.
 */
function createTransport(account) {
  const password = account.imap_password_encrypted
    ? decrypt(account.imap_password_encrypted)
    : '';

  return nodemailer.createTransport({
    host:   account.smtp_host,
    port:   account.smtp_port || 587,
    secure: !!account.smtp_secure,
    auth: {
      user: account.imap_user || account.email_address,
      pass: password,
    },
    // Self-hosted servers frequently use self-signed certs; don't reject them.
    tls: { rejectUnauthorized: false },
  });
}

/**
 * Send an email via SMTP using the account's stored credentials.
 * @param {object} account  — email_accounts row from DB
 * @param {object} opts     — { to, cc, bcc, subject, text, replyTo }
 */
async function sendEmail(account, { to, cc, bcc, subject, text, replyTo } = {}) {
  const transport = createTransport(account);

  await transport.sendMail({
    from:    `${account.display_name || ''} <${account.email_address}>`.trim(),
    to,
    cc:      cc  || undefined,
    bcc:     bcc || undefined,
    subject: subject || '(no subject)',
    text:    text || '',
    ...(replyTo ? { replyTo } : {}),
  });
}

module.exports = { sendEmail };
