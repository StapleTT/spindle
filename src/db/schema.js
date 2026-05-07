const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const fs = require('fs');

const DB_PATH = path.join(__dirname, '../../data/spindle.db');

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new DatabaseSync(DB_PATH);

db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS sessions (
    sid     TEXT PRIMARY KEY,
    sess    TEXT NOT NULL,
    expire  INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    recovery_email TEXT,
    role TEXT DEFAULT 'user',
    theme TEXT DEFAULT 'system',
    invite_code_used TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS invite_codes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    code TEXT UNIQUE NOT NULL,
    created_by INTEGER REFERENCES users(id),
    used_by INTEGER REFERENCES users(id),
    revoked INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS email_accounts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    display_name TEXT,
    email_address TEXT NOT NULL,
    provider TEXT,
    sort_order INTEGER DEFAULT 0,
    imap_host TEXT,
    imap_port INTEGER,
    imap_secure INTEGER DEFAULT 1,
    smtp_host TEXT,
    smtp_port INTEGER,
    smtp_secure INTEGER DEFAULT 1,
    imap_user TEXT,
    imap_password_encrypted TEXT,
    oauth_access_token TEXT,
    oauth_refresh_token TEXT,
    oauth_token_expiry DATETIME,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS recovery_tokens (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    token_hash TEXT NOT NULL,
    expires_at DATETIME NOT NULL,
    used INTEGER DEFAULT 0
  );
`);

// Migrations — safe to run on every boot
try {
  db.exec(`ALTER TABLE users ADD COLUMN auto_load_images INTEGER DEFAULT 0`);
} catch (e) {
  if (!e.message.includes('duplicate column name')) throw e;
}
try {
  db.exec(`ALTER TABLE users ADD COLUMN paused INTEGER DEFAULT 0`);
} catch (e) {
  if (!e.message.includes('duplicate column name')) throw e;
}

module.exports = db;
