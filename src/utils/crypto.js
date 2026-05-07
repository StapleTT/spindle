const crypto = require('crypto');

const ALG = 'aes-256-gcm';
const KEY_HEX = process.env.ENCRYPTION_KEY || '0'.repeat(64); // 32-byte key as 64-char hex
const KEY = Buffer.from(KEY_HEX, 'hex');

/**
 * AES-256-GCM encrypt a string. Returns "iv:authTag:ciphertext" (all hex).
 */
function encrypt(plaintext) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALG, KEY, iv);
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('hex')}:${tag.toString('hex')}:${enc.toString('hex')}`;
}

/**
 * AES-256-GCM decrypt a string produced by encrypt().
 */
function decrypt(payload) {
  const [ivHex, tagHex, ctHex] = payload.split(':');
  const decipher = crypto.createDecipheriv(ALG, KEY, Buffer.from(ivHex, 'hex'));
  decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
  const dec = Buffer.concat([decipher.update(Buffer.from(ctHex, 'hex')), decipher.final()]);
  return dec.toString('utf8');
}

/**
 * Generate a cryptographically random token as a hex string.
 * @param {number} bytes - number of random bytes (default 32 → 64-char hex)
 */
function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('hex');
}

/**
 * SHA-256 hash a token for safe storage.
 */
function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

/**
 * Invite code format: XXXX-XXXX-XXXX where X is an uppercase hex digit (0-9, A-F).
 * Example: 74E7-10C0-0CAF
 */
const INVITE_CODE_REGEX = /^[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}$/;

/**
 * Generate a cryptographically random invite code in XXXX-XXXX-XXXX hex format.
 */
function randomInviteCode() {
  const hex = () => crypto.randomBytes(2).toString('hex').toUpperCase();
  return `${hex()}-${hex()}-${hex()}`;
}

module.exports = { encrypt, decrypt, randomToken, hashToken, randomInviteCode, INVITE_CODE_REGEX };
