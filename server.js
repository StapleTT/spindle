require('dotenv').config();
const express = require('express');
const session = require('express-session');
const helmet = require('helmet');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const path = require('path');

// Init DB (runs schema creation on require)
require('./src/db/schema');

const app = express();

// TRUST_PROXY: IP/subnet of your reverse proxy (e.g. '10.0.0.1').
// Set in .env when nginx runs on a separate machine; defaults to 'loopback' (same machine).
const _trustProxy = process.env.TRUST_PROXY || 'loopback';
app.set('trust proxy', /^\d+$/.test(_trustProxy) ? parseInt(_trustProxy, 10) : _trustProxy);

// --- Security middleware ---
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "cdn.jsdelivr.net", "cdn.quilljs.com"],
      scriptSrcAttr: [],
      styleSrc: ["'self'", "'unsafe-inline'", "cdn.jsdelivr.net", "cdn.quilljs.com", "fonts.googleapis.com"],
      fontSrc: ["'self'", "fonts.gstatic.com"],
      imgSrc: ["'self'", "data:", "https:", "http:"],
      frameSrc: ["'none'"],
    },
  },
}));

app.use(cors({ origin: false }));
app.use(express.json({ limit: '10kb' }));
app.use(express.urlencoded({ extended: true, limit: '10kb' }));

// --- SQLite session store (uses the same DB as the app; no file-lock issues on Windows) ---
const db = require('./src/db/schema');

class SQLiteStore extends session.Store {
  constructor() {
    super();
    this._get  = db.prepare('SELECT sess FROM sessions WHERE sid = ? AND expire > ?');
    this._set  = db.prepare('INSERT OR REPLACE INTO sessions (sid, sess, expire) VALUES (?, ?, ?)');
    this._touch = db.prepare('UPDATE sessions SET expire = ? WHERE sid = ?');
    this._del  = db.prepare('DELETE FROM sessions WHERE sid = ?');
    this._reap = db.prepare('DELETE FROM sessions WHERE expire <= ?');
    // Prune expired sessions every 15 minutes
    setInterval(() => this._reap.run(Date.now()), 15 * 60 * 1000).unref();
  }
  get(sid, cb) {
    try {
      const row = this._get.get(sid, Date.now());
      cb(null, row ? JSON.parse(row.sess) : null);
    } catch (e) { cb(e); }
  }
  set(sid, sess, cb) {
    try {
      const exp = sess.cookie && sess.cookie.expires
        ? new Date(sess.cookie.expires).getTime()
        : Date.now() + 7 * 24 * 3600 * 1000;
      this._set.run(sid, JSON.stringify(sess), exp);
      cb(null);
    } catch (e) { cb(e); }
  }
  touch(sid, sess, cb) {
    try {
      const exp = sess.cookie && sess.cookie.expires
        ? new Date(sess.cookie.expires).getTime()
        : Date.now() + 7 * 24 * 3600 * 1000;
      this._touch.run(exp, sid);
      cb(null);
    } catch (e) { cb(e); }
  }
  destroy(sid, cb) {
    try { this._del.run(sid); cb(null); } catch (e) { cb(e); }
  }
}

const SESSION_SECRET = process.env.SESSION_SECRET;
if (!SESSION_SECRET) {
  throw new Error('SESSION_SECRET env var is required (run: openssl rand -hex 32)');
}

app.use(session({
  store: new SQLiteStore(),
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
  },
}));

// --- CSRF protection ---
app.use(require('./src/middleware/csrf'));

// --- Rate limiting for auth mutation routes (skips GET /me session check) ---
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  skip: (req) => req.method === 'GET',
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again later.' },
});

// --- Routes ---
app.use('/api/auth', authLimiter, require('./src/routes/auth'));
app.use('/api/accounts', require('./src/routes/accounts'));
app.use('/api/email', require('./src/routes/email'));
app.use('/api/settings', require('./src/routes/settings'));
app.use('/api/admin', require('./src/routes/admin'));
app.use('/api/oauth', require('./src/routes/oauth'));

// --- Mobile browser redirect ---
const _MOBILE_UA = /Android|iPhone|iPad|iPod|IEMobile|Opera Mini|BlackBerry|Mobile/i;
const _MOBILE_MAP = {
  '/': '/m/', '/inbox': '/m/inbox', '/auth': '/m/auth',
  '/recovery': '/m/recovery', '/privacy-policy': '/m/privacy-policy', '/tos': '/m/tos',
};
app.use((req, res, next) => {
  if (req.method !== 'GET' || req.query.desktop) return next();
  const dest = _MOBILE_MAP[req.path];
  if (!dest || !_MOBILE_UA.test(req.get('User-Agent') || '')) return next();
  const params = Object.entries(req.query).filter(([k]) => k !== 'desktop');
  const qs = new URLSearchParams(Object.fromEntries(params)).toString();
  res.redirect(302, dest + (qs ? '?' + qs : ''));
});

// --- Redirect legacy .html URLs to clean equivalents (must precede static) ---
app.get('/inbox.html', (req, res) => {
  const qs = new URLSearchParams(req.query).toString();
  res.redirect(301, '/inbox' + (qs ? '?' + qs : ''));
});
app.get('/auth.html',           (req, res) => res.redirect(301, '/auth'));
app.get('/recovery.html', (req, res) => {
  const qs = new URLSearchParams(req.query).toString();
  res.redirect(301, '/recovery' + (qs ? '?' + qs : ''));
});
app.get('/privacy-policy.html', (req, res) => res.redirect(301, '/privacy-policy'));
app.get('/tos.html',            (req, res) => res.redirect(301, '/tos'));

// --- Static files (CSS, JS, images, etc.) ---
app.use(express.static(path.join(__dirname, 'public')));

// --- Clean URL page routes ---
app.get('/inbox',          (req, res) => res.sendFile(path.join(__dirname, 'public', 'inbox.html')));
app.get('/auth',           (req, res) => res.sendFile(path.join(__dirname, 'public', 'auth.html')));
app.get('/recovery',       (req, res) => res.sendFile(path.join(__dirname, 'public', 'recovery.html')));
app.get('/privacy-policy', (req, res) => res.sendFile(path.join(__dirname, 'public', 'privacy-policy.html')));
app.get('/tos',            (req, res) => res.sendFile(path.join(__dirname, 'public', 'tos.html')));

// --- Mobile pages (/m/*) ---
app.get('/m',                  (req, res) => res.sendFile(path.join(__dirname, 'public', 'm', 'index.html')));
app.get('/m/',                 (req, res) => res.sendFile(path.join(__dirname, 'public', 'm', 'index.html')));
app.get('/m/inbox',            (req, res) => res.sendFile(path.join(__dirname, 'public', 'm', 'inbox.html')));
app.get('/m/auth',             (req, res) => res.sendFile(path.join(__dirname, 'public', 'm', 'auth.html')));
app.get('/m/recovery',         (req, res) => res.sendFile(path.join(__dirname, 'public', 'm', 'recovery.html')));
app.get('/m/privacy-policy',   (req, res) => res.sendFile(path.join(__dirname, 'public', 'm', 'privacy-policy.html')));
app.get('/m/tos',              (req, res) => res.sendFile(path.join(__dirname, 'public', 'm', 'tos.html')));

// 404 handler — must be last before the error handler
app.use((req, res) => {
  if (req.path.startsWith('/api/')) {
    return res.status(404).json({ error: 'Not found' });
  }
  res.status(404).sendFile(path.join(__dirname, 'public', '404.html'));
});

// --- Global error handler ---
// Express 4 does NOT forward rejected promises from async route handlers to
// error middleware automatically. Combined with our handlers being `async`, an
// unhandled rejection (e.g. a library throwing on bad input) would leave the
// request without a response — it would hang until the proxy 504s. Catching the
// `body-parser` "request entity too large"/"invalid JSON" errors here also turns
// them into clean JSON 4xx responses instead of HTML stack traces.
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  if (err.type === 'entity.too.large') {
    return res.status(413).json({ error: 'Request body too large' });
  }
  if (err.type === 'entity.parse.failed' || err instanceof SyntaxError) {
    return res.status(400).json({ error: 'Invalid request body' });
  }
  console.error('[unhandled]', req.method, req.path, '-', err && err.message);
  if (req.path.startsWith('/api/')) {
    return res.status(500).json({ error: 'Internal server error' });
  }
  res.status(500).sendFile(path.join(__dirname, 'public', '404.html'));
});

// --- Start ---
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Spindle running on http://localhost:${PORT}`);
  // Signal PM2 that the app is ready (enables listen-timeout hang detection)
  if (process.send) process.send('ready');
});

module.exports = app;
