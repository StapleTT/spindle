const router = require('express').Router();
const bcrypt = require('bcrypt');
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

// PATCH /api/admin/users/:id/role — toggle admin ↔ user
router.patch('/users/:id/role', (req, res) => {
  const targetId = parseInt(req.params.id);
  if (targetId === req.user.id) {
    return res.status(400).json({ error: 'Cannot change your own role' });
  }
  const target = q.getUserById.get(targetId);
  if (!target) return res.status(404).json({ error: 'User not found' });
  const newRole = target.role === 'admin' ? 'user' : 'admin';
  q.updateUserRole.run(newRole, targetId);
  res.json({ role: newRole });
});

// PATCH /api/admin/users/:id/pause — toggle paused
router.patch('/users/:id/pause', (req, res) => {
  const targetId = parseInt(req.params.id);
  if (targetId === req.user.id) {
    return res.status(400).json({ error: 'Cannot pause your own account' });
  }
  const target = q.getUserById.get(targetId);
  if (!target) return res.status(404).json({ error: 'User not found' });
  const newPaused = target.paused ? 0 : 1;
  q.setUserPaused.run(newPaused, targetId);
  res.json({ paused: !!newPaused });
});

// DELETE /api/admin/users/:id — permanently delete a user account
router.delete('/users/:id', async (req, res) => {
  const targetId = parseInt(req.params.id);
  if (targetId === req.user.id) {
    return res.status(400).json({ error: 'Cannot delete your own account here' });
  }
  const target = q.getUserById.get(targetId);
  if (!target) return res.status(404).json({ error: 'User not found' });

  const { password } = req.body;
  if (!password) return res.status(400).json({ error: 'password is required' });

  const match = await bcrypt.compare(password, req.user.password_hash);
  if (!match) return res.status(403).json({ error: 'Incorrect password' });

  if (target.invite_code_used) {
    q.revokeInviteCode.run(target.invite_code_used);
  }
  q.clearInviteCodesUsedBy.run(targetId);
  q.clearInviteCodesCreatedBy.run(targetId);
  q.deleteUser.run(targetId);

  res.json({ ok: true });
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

// DELETE /api/admin/invite-codes/:code — permanently delete an unused code
router.delete('/invite-codes/:code', (req, res) => {
  const { code } = req.params;
  if (!INVITE_CODE_REGEX.test(code)) {
    return res.status(400).json({ error: 'Invalid invite code format' });
  }
  const existing = q.getInviteCode.get(code);
  if (!existing) return res.status(404).json({ error: 'Code not found' });
  if (existing.used_by) return res.status(400).json({ error: 'Cannot delete a used code' });
  q.deleteInviteCode.run(code);
  res.json({ ok: true });
});

module.exports = router;
