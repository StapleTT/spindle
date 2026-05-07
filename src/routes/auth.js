const router = require('express').Router();
const bcrypt = require('bcrypt');
const db = require('../db/schema');
const q = require('../db/queries');
const requireAuth = require('../middleware/requireAuth');
const { randomToken, hashToken, INVITE_CODE_REGEX } = require('../utils/crypto');

const BCRYPT_ROUNDS = 12;

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
  res.json({ id, username, role, theme, auto_load_images: !!auto_load_images });
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

    // Send recovery email (requires SYSTEM_SMTP to be configured)
    try {
      const nodemailer = require('nodemailer');
      const transporter = nodemailer.createTransport({
        host: process.env.SYSTEM_SMTP_HOST,
        port: parseInt(process.env.SYSTEM_SMTP_PORT) || 587,
        auth: {
          user: process.env.SYSTEM_SMTP_USER,
          pass: process.env.SYSTEM_SMTP_PASS,
        },
      });
      const resetUrl = `${process.env.APP_URL || 'http://localhost:3000'}/recovery?token=${token}`;
      await transporter.sendMail({
        from: process.env.SYSTEM_FROM_EMAIL || 'Spindle <noreply@spindle.local>',
        to: user.recovery_email,
        subject: 'Spindle — password reset',
        text: `Reset your Spindle password:\n\n${resetUrl}\n\nThis link expires in 1 hour and can only be used once.\n\nIf you didn't request this, ignore this email.`,
      });
    } catch (mailErr) {
      console.error('[recovery] email send failed:', mailErr.message);
      // Don't expose mail errors to client
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
