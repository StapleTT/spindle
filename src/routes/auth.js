const router = require('express').Router();
const bcrypt = require('bcrypt');
const db = require('../db/schema');
const q = require('../db/queries');
const requireAuth = require('../middleware/requireAuth');
const { randomToken, hashToken, INVITE_CODE_REGEX } = require('../utils/crypto');

const BCRYPT_ROUNDS = 12;

// ── Recovery email template ───────────────────────────────────────────────────
function buildRecoveryEmail(username, resetUrl, appUrl) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Spindle — password reset</title>
</head>
<body style="margin:0;padding:0;background:#0a0a0a;font-family:'Courier New',Courier,monospace;color:#d4d4d4">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#0a0a0a;padding:48px 16px">
  <tr><td align="center">
    <table width="100%" cellpadding="0" cellspacing="0" style="max-width:520px">

      <!-- Logo -->
      <tr><td style="padding-bottom:32px;text-align:left">
        <span style="font-size:15px;font-weight:600;letter-spacing:0.04em;color:#f0f0f0">spindle</span>
      </td></tr>

      <!-- Card -->
      <tr><td style="background:#111111;border:1px solid rgba(255,255,255,0.10);border-radius:4px;padding:32px">

        <p style="margin:0 0 8px;font-size:11px;letter-spacing:0.18em;text-transform:uppercase;color:#888888">// account recovery</p>
        <p style="margin:0 0 24px;font-size:18px;font-weight:600;color:#f0f0f0;letter-spacing:-0.01em">Password reset</p>

        <p style="margin:0 0 20px;font-size:13px;line-height:1.7;color:#d4d4d4">
          Hi <span style="color:#f0f0f0;font-weight:600">${username}</span>,<br><br>
          Someone requested a password reset for your Spindle account. Click the button below to choose a new password.
        </p>

        <!-- CTA button -->
        <table cellpadding="0" cellspacing="0" style="margin:28px 0">
          <tr><td style="background:#f0f0f0;border-radius:2px">
            <a href="${resetUrl}" style="display:inline-block;padding:12px 24px;font-family:'Courier New',Courier,monospace;font-size:13px;font-weight:600;color:#0a0a0a;text-decoration:none;letter-spacing:0.02em">[ reset password ] ↵</a>
          </td></tr>
        </table>

        <p style="margin:0 0 12px;font-size:12px;line-height:1.6;color:#888888">
          This link expires in <span style="color:#d4d4d4">1 hour</span> and can only be used once.<br>
          If you didn't request this, you can safely ignore this email.
        </p>

        <!-- Fallback URL -->
        <div style="margin-top:24px;padding:12px 14px;background:#0a0a0a;border:1px solid rgba(255,255,255,0.08);border-radius:2px;word-break:break-all">
          <span style="font-size:10px;color:#555555;letter-spacing:0.1em;text-transform:uppercase;display:block;margin-bottom:6px">// or copy this link</span>
          <a href="${resetUrl}" style="font-size:11px;color:#888888;text-decoration:none">${resetUrl}</a>
        </div>

      </td></tr>

      <!-- Footer -->
      <tr><td style="padding-top:24px;text-align:left">
        <p style="margin:0;font-size:11px;color:#555555;line-height:1.6">
          Sent by <a href="${appUrl}" style="color:#555555">Spindle</a> &mdash; centralized email client<br>
          This is an automated message. Do not reply to this address.
        </p>
      </td></tr>

    </table>
  </td></tr>
</table>
</body>
</html>`;
}

// Password strength checker — matches frontend requirements
function passwordStrong(p) {
  return (
    typeof p === 'string' &&
    p.length >= 12 &&
    /[A-Z]/.test(p) &&
    /[0-9]/.test(p) &&
    /[!@#$%^&*()\-_=+[\]{};:,.<>?/\\|~`]/.test(p)
  );
}

// POST /api/auth/register
router.post('/register', async (req, res) => {
  const { username, password, invite_code, recovery_email } = req.body;

  if (!username || !password || !invite_code) {
    return res.status(400).json({ error: 'username, password, and invite_code are required' });
  }
  if (typeof username !== 'string' || username.length < 2 || username.length > 15) {
    return res.status(400).json({ error: 'Username must be 2–15 characters' });
  }
  if (!passwordStrong(password)) {
    return res.status(400).json({
      error: 'Password must be at least 12 characters and include an uppercase letter, number, and symbol',
    });
  }

  if (!INVITE_CODE_REGEX.test(invite_code)) {
    return res.status(400).json({ error: 'Invalid invite code format' });
  }
  const code = q.getInviteCode.get(invite_code);
  if (!code || code.revoked || code.used_by) {
    return res.status(400).json({ error: 'Invalid or already-used invite code' });
  }

  const existing = q.getUserByUsername.get(username);
  if (existing) {
    return res.status(400).json({ error: 'Username already taken' });
  }

  const { count } = q.countUsers.get();
  const role = count === 0 ? 'admin' : 'user';

  const password_hash = await bcrypt.hash(password, BCRYPT_ROUNDS);

  const result = q.insertUser.run({
    username,
    password_hash,
    recovery_email: recovery_email || null,
    role,
    invite_code_used: invite_code,
  });

  q.markInviteCodeUsed.run({ used_by: result.lastInsertRowid, code: invite_code });

  req.session.regenerate((err) => {
    if (err) return res.status(500).json({ error: 'Session error' });
    req.session.userId = result.lastInsertRowid;
    req.session.role = role;
    res.status(201).json({ id: result.lastInsertRowid, username, role, theme: 'system', auto_load_images: false });
  });
});

// POST /api/auth/login
router.post('/login', async (req, res) => {
  const { username, password } = req.body;

  if (!username || !password) {
    return res.status(400).json({ error: 'username and password are required' });
  }

  const user = q.getUserByUsername.get(username);

  // Always run bcrypt to prevent timing attacks when user not found
  const hash = user ? user.password_hash : '$2b$12$invalidhashtopreventtimingattack000000000000000000000';
  const match = await bcrypt.compare(password, hash);

  if (!user || !match) {
    return res.status(401).json({ error: 'Invalid username or password' });
  }

  if (user.paused) {
    return res.status(403).json({ error: 'This account has been paused' });
  }

  req.session.regenerate((err) => {
    if (err) return res.status(500).json({ error: 'Session error' });
    req.session.userId = user.id;
    req.session.role = user.role;
    res.json({ id: user.id, username: user.username, role: user.role, theme: user.theme, auto_load_images: !!user.auto_load_images });
  });
});

// POST /api/auth/logout
router.post('/logout', (req, res) => {
  req.session.destroy((err) => {
    if (err) return res.status(500).json({ error: 'Logout failed' });
    res.clearCookie('connect.sid');
    res.json({ ok: true });
  });
});

// GET /api/auth/me
router.get('/me', requireAuth, (req, res) => {
  const { id, username, role, theme, auto_load_images } = req.user;
  res.json({
    id, username, role, theme,
    auto_load_images: !!auto_load_images,
    csrfToken: req.session.csrfToken || null,
  });
});

// ─── Recovery ────────────────────────────────────────────────────────────────

// POST /api/auth/recovery/request
router.post('/recovery/request', async (req, res) => {
  // Always return generic response to prevent user enumeration
  const GENERIC = { ok: true, message: 'If a matching account exists, a reset link has been dispatched.' };

  const { username, recovery_email } = req.body;
  if (!username || !recovery_email) return res.json(GENERIC);

  try {
    const user = q.getUserByRecoveryEmail.get(username, recovery_email);
    if (!user) return res.json(GENERIC);

    const token = randomToken(32);
    const token_hash = hashToken(token);
    const expires_at = new Date(Date.now() + 60 * 60 * 1000).toISOString(); // 1 hour

    q.insertRecoveryToken.run({ user_id: user.id, token_hash, expires_at });

    // Send recovery email (requires SYSTEM_SMTP_* env vars to be configured)
    if (!process.env.SYSTEM_SMTP_HOST) {
      console.warn('[recovery] SYSTEM_SMTP_HOST not set — skipping email send');
    } else {
      try {
        const nodemailer = require('nodemailer');
        const port   = parseInt(process.env.SYSTEM_SMTP_PORT) || 25;
        const secure = port === 465; // true for SSL, false for STARTTLS/plain
        const smtpUser = process.env.SYSTEM_SMTP_USER;
        const smtpPass = process.env.SYSTEM_SMTP_PASS;
        const transporter = nodemailer.createTransport({
          host: process.env.SYSTEM_SMTP_HOST,
          port,
          secure,
          // Only include auth when credentials are provided (local Postfix doesn't need them)
          ...(smtpUser && smtpPass ? { auth: { user: smtpUser, pass: smtpPass } } : {}),
        });

        const appUrl   = process.env.APP_URL || 'http://localhost:3000';
        const resetUrl = `${appUrl}/recovery?token=${token}`;
        const from     = process.env.SYSTEM_FROM_EMAIL || 'Spindle <noreply@spindle.staplett.xyz>';

        const html = buildRecoveryEmail(user.username, resetUrl, appUrl);
        const text = `Hi ${user.username},\n\nReset your Spindle password by visiting this link:\n\n${resetUrl}\n\nThis link expires in 1 hour and can only be used once. If you did not request a password reset, you can safely ignore this email.\n\n— Spindle`;

        await transporter.sendMail({ from, to: user.recovery_email, subject: 'Spindle — password reset', html, text });
      } catch (mailErr) {
        console.error('[recovery] email send failed:', mailErr.message);
      }
    }
  } catch (err) {
    console.error('[recovery/request]', err);
  }

  res.json(GENERIC);
});

// POST /api/auth/recovery/reset
router.post('/recovery/reset', async (req, res) => {
  const { token, new_password } = req.body;
  if (!token || !new_password) {
    return res.status(400).json({ error: 'token and new_password are required' });
  }
  if (!passwordStrong(new_password)) {
    return res.status(400).json({
      error: 'Password must be at least 12 characters and include an uppercase letter, number, and symbol',
    });
  }

  const token_hash = hashToken(token);
  const record = q.getValidRecoveryToken.get(token_hash);
  if (!record) {
    return res.status(400).json({ error: 'Invalid or expired reset token' });
  }

  const password_hash = await bcrypt.hash(new_password, BCRYPT_ROUNDS);
  q.updateUserPassword.run(password_hash, record.user_id);
  q.markRecoveryTokenUsed.run(record.id);

  res.json({ ok: true });
});

module.exports = router;
