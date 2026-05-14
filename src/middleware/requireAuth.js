const { getUserById } = require('../db/queries');

function requireAuth(req, res, next) {
  if (!req.session.userId) {
    return res.status(401).json({ error: 'Not authenticated' });
  }
  const user = getUserById.get(req.session.userId);
  if (!user || user.paused) {
    req.session.destroy(() => {});
    return res.status(401).json({ error: 'Not authenticated' });
  }
  req.user = user;
  next();
}

module.exports = requireAuth;
