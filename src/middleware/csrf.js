/**
 * csrf.js — Synchronizer-token CSRF protection for state-changing API routes.
 *
 * A random token is generated per session and stored in req.session.csrfToken.
 * All non-GET/HEAD/OPTIONS requests must supply it as the X-CSRF-Token header.
 *
 * Exemptions:
 *   /api/auth/login, /api/auth/register  — no session exists yet
 *   /api/auth/bootstrap-invite          — only works when no users exist; no session possible
 *   /api/auth/recovery/*                — protected by time-limited one-use token
 *   /api/oauth/*                        — protected by the OAuth `state` parameter
 */

const crypto = require('crypto');

const CSRF_EXEMPT = new Set([
  '/api/auth/login',
  '/api/auth/register',
  '/api/auth/recovery/request',
  '/api/auth/recovery/reset',
  '/api/auth/bootstrap-invite',
]);

function csrf(req, res, next) {
  // Ensure every session carries a CSRF token
  if (req.session && !req.session.csrfToken) {
    req.session.csrfToken = crypto.randomBytes(32).toString('hex');
  }

  // Safe methods — no state change possible
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();

  // Explicitly exempt endpoints
  if (CSRF_EXEMPT.has(req.path) || req.path.startsWith('/api/oauth/')) return next();

  const provided = req.headers['x-csrf-token'];
  if (!provided || !req.session || !req.session.csrfToken) {
    return res.status(403).json({ error: 'CSRF token missing or invalid' });
  }
  const a = Buffer.from(provided);
  const b = Buffer.from(req.session.csrfToken);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return res.status(403).json({ error: 'CSRF token missing or invalid' });
  }

  next();
}

module.exports = csrf;
