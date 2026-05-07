const router = require('express').Router();
const requireAuth = require('../middleware/requireAuth');
const requireAdmin = require('../middleware/requireAdmin');
const q = require('../db/queries');
const { randomInviteCode, INVITE_CODE_REGEX } = require('../utils/crypto');

router.use(requireAuth, requireAdmin);

// GET /api/admin/users
router.get('/users', (req, res) => {
  const users = q.getAllUsers.all();
  res.json(users);
});

// GET /api/admin/invite-codes
router.get('/invite-codes', (req, res) => {
  const codes = q.getAllInviteCodes.all();
  res.json(codes);
});

// POST /api/admin/invite-codes — generate a new code
router.post('/invite-codes', (req, res) => {
  const code = randomInviteCode();
  q.insertInviteCode.run({ code, created_by: req.user.id });
  res.status(201).json({ code });
});

// DELETE /api/admin/invite-codes/:code — revoke a code
router.delete('/invite-codes/:code', (req, res) => {
  const { code } = req.params;
  if (!INVITE_CODE_REGEX.test(code)) {
    return res.status(400).json({ error: 'Invalid invite code format' });
  }
  const existing = q.getInviteCode.get(code);
  if (!existing) return res.status(404).json({ error: 'Code not found' });
  if (existing.used_by) return res.status(400).json({ error: 'Cannot revoke a used code' });
  q.revokeInviteCode.run(code);
  res.json({ ok: true });
});

module.exports = router;
