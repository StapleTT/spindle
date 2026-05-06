/**
 * One-time bootstrap: inserts a single invite code so the first user can register.
 * Run with: node scripts/seed-invite.js
 */
const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const crypto = require('crypto');

const DB_PATH = path.join(__dirname, '../data/spindle.db');
const db = new DatabaseSync(DB_PATH);

db.exec('PRAGMA foreign_keys = ON');

const raw = crypto.randomBytes(6).toString('hex').toUpperCase();
const code = `${raw.slice(0,4)}-${raw.slice(4,8)}-${raw.slice(8,12)}`;

db.prepare(`INSERT INTO invite_codes (code, created_by) VALUES (?, NULL)`).run(code);

console.log('Bootstrap invite code created:');
console.log('');
console.log(`  ${code}`);
console.log('');
console.log('Use this code on the register page. It will be consumed on first use.');
