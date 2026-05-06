const router = require('express').Router();
const bcrypt = require('bcrypt');
const requireAuth = require('../middleware/requireAuth');
const db = require('../db/queries');

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

// DELETE /api/settings/account
router.delete('/account', async (req, res) => {
  const { password } = req.body;
  if (!password) return res.status(400).json({ error: 'Password required' });

  const valid = await bcrypt.compare(password, req.user.password_hash);
  if (!valid) return res.status(403).json({ error: 'Incorrect password' });

  db.deleteUser.run(req.user.id);

  req.session.destroy(() => {
    res.json({ ok: true });
  });
});

module.exports = router;
