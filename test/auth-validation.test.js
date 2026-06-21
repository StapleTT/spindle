// Regression test for the type-confusion DoS fix.
//
// Non-string values for auth fields used to reach bcrypt.compare, which rejects
// on non-string input; because the async handler's rejection wasn't forwarded,
// the request hung until the proxy 504'd at 60s. These tests assert such inputs
// now get a fast 400 instead.
//
// Run with: npm test   (uses Node's built-in test runner — no extra deps)

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const express = require('express');

// Env vars required by the modules the auth router pulls in.
process.env.SESSION_SECRET ||= 'test_secret';
process.env.ENCRYPTION_KEY ||= '0'.repeat(64);

let server, base;

before(async () => {
  const authRouter = require('../src/routes/auth');
  const app = express();
  app.use(express.json({ limit: '10kb' }));
  // Minimal session stub so handlers that touch req.session don't crash.
  app.use((req, res, next) => {
    req.session = { regenerate: (cb) => cb(null), destroy: (cb) => cb(null) };
    next();
  });
  app.use('/api/auth', authRouter);
  // Mirror of server.js's global error handler so an unhandled rejection here
  // surfaces as a 500 (and a test failure) rather than a hang.
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    res.status(500).json({ error: 'unhandled' });
  });
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => { if (server) server.close(); });

async function post(path, body) {
  const start = Date.now();
  const res = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, ms: Date.now() - start, body: await res.json().catch(() => ({})) };
}

const NON_STRINGS = [{ $ne: 'x' }, { $gt: '' }, true, false, 123, ['x'], { a: 1 }];

test('POST /login rejects non-string username/password with a fast 400', async () => {
  for (const v of NON_STRINGS) {
    const a = await post('/api/auth/login', { username: v, password: 'Password!1234' });
    assert.equal(a.status, 400, `username=${JSON.stringify(v)} should be 400`);
    assert.ok(a.ms < 2000, `username=${JSON.stringify(v)} took ${a.ms}ms — should be fast`);

    const b = await post('/api/auth/login', { username: 'staple', password: v });
    assert.equal(b.status, 400, `password=${JSON.stringify(v)} should be 400`);
    assert.ok(b.ms < 2000, `password=${JSON.stringify(v)} took ${b.ms}ms — should be fast`);
  }
});

test('POST /register rejects non-string fields with 400', async () => {
  for (const v of NON_STRINGS) {
    const r = await post('/api/auth/register', { username: v, password: 'Password!1234', invite_code: 'AAAA-BBBB-CCCC' });
    assert.equal(r.status, 400);
    assert.ok(r.ms < 2000);
  }
});

test('POST /recovery/reset rejects non-string token/new_password with 400', async () => {
  for (const v of NON_STRINGS) {
    const r = await post('/api/auth/recovery/reset', { token: v, new_password: 'Password!1234' });
    assert.equal(r.status, 400);
    assert.ok(r.ms < 2000);
  }
});

test('POST /login still returns 401 for a well-formed but wrong credential', async () => {
  const r = await post('/api/auth/login', { username: 'definitely-no-such-user', password: 'Password!1234' });
  assert.equal(r.status, 401);
});
