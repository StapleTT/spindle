const router = require('express').Router();
const bcrypt = require('bcrypt');
const requireAuth = require('../middleware/requireAuth');
const db = require('../db/queries');
const imap = require('../services/imap');

router.use(requireAuth);

// PATCH /api/settings/theme
router.patch('/theme', (req, res) => {
  const { theme } = req.body;
  if (!['light', 'dark', 'system'].includes(theme)) {
    return res.status(400).json({ error: 'Invalid theme value' });
  }
  db.updateUserTheme.run(theme, req.user.id);
  res.json({ theme });
});

// PATCH /api/settings/images
router.patch('/images', (req, res) => {
  const { auto_load_images } = req.body;
  if (typeof auto_load_images !== 'boolean') {
    return res.status(400).json({ error: 'auto_load_images must be a boolean' });
  }
  db.updateUserImages.run(auto_load_images ? 1 : 0, req.user.id);
  res.json({ auto_load_images });
});

// DELETE /api/settings/account
router.delete('/account', async (req, res) => {
  const { password } = req.body;
  if (!password) return res.status(400).json({ error: 'Password required' });

  const valid = await bcrypt.compare(password, req.user.password_hash);
  if (!valid) return res.status(403).json({ error: 'Incorrect password' });

  try {
    // Evict any open IMAP connections for this user's accounts
    const accounts = db.getEmailAccountsByUser.all(req.user.id);
    for (const acct of accounts) imap.evict(acct.id);

    // Nullify invite_codes references — those columns have no ON DELETE CASCADE
    db.clearInviteCodesUsedBy.run(req.user.id);
    db.clearInviteCodesCreatedBy.run(req.user.id);

    // Delete user — email_accounts and recovery_tokens cascade automatically
    db.deleteUser.run(req.user.id);
  } catch (e) {
    console.error('[settings] account deletion failed:', e);
    return res.status(500).json({ error: 'Account deletion failed' });
  }

  req.session.destroy(() => {
    res.json({ ok: true });
  });
});

module.exports = router;
