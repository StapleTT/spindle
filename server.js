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

// Trust the first proxy (nginx) so X-Forwarded-For is used for real client IPs
app.set('trust proxy', 1);

// --- Security middleware ---
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'", "cdn.jsdelivr.net", "cdn.quilljs.com"],
      scriptSrcAttr: ["'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'", "cdn.jsdelivr.net", "cdn.quilljs.com", "fonts.googleapis.com"],
      fontSrc: ["'self'", "fonts.gstatic.com"],
      imgSrc: ["'self'", "data:", "https:", "http:"],
      frameSrc: ["'none'"],
    },
  },
}));

app.use(cors({ origin: false }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

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

app.use(session({
  store: new SQLiteStore(),
  secret: process.env.SESSION_SECRET || 'dev-secret-change-me',
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

// --- Rate limiting for auth routes ---
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
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

// 404 handler — must be last
app.use((req, res) => {
  if (req.path.startsWith('/api/')) {
    return res.status(404).json({ error: 'Not found' });
  }
  res.status(404).sendFile(path.join(__dirname, 'public', '404.html'));
});

// --- Start ---
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Spindle running on http://localhost:${PORT}`);
});

module.exports = app;
