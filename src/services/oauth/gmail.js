/**
 * gmail.js — Gmail OAuth2 service.
 *
 * Handles auth URL generation, code exchange, profile fetching, and
 * returning an authenticated client for Gmail API calls (with auto token refresh).
 */

const { google } = require('googleapis');
const { encrypt, decrypt } = require('../../utils/crypto');
const db = require('../../db/queries');

function createOAuth2Client() {
  return new google.auth.OAuth2(
    process.env.GMAIL_CLIENT_ID,
    process.env.GMAIL_CLIENT_SECRET,
    `${process.env.APP_URL || 'http://localhost:3000'}/api/oauth/gmail/callback`
  );
}

/**
 * Generate the Google consent-screen URL.
 * @param {string} state — CSRF token stored in session
 */
function getAuthUrl(state) {
  const client = createOAuth2Client();
  return client.generateAuthUrl({
    access_type: 'offline',
    prompt:      'consent',   // always return a refresh_token
    state,
    scope: [
      'https://www.googleapis.com/auth/gmail.readonly',
      'https://www.googleapis.com/auth/gmail.send',
      'https://www.googleapis.com/auth/gmail.modify',
      'https://www.googleapis.com/auth/userinfo.email',
      'https://www.googleapis.com/auth/userinfo.profile',
    ],
  });
}

/**
 * Exchange an authorization code for access + refresh tokens.
 * @returns {object} tokens — { access_token, refresh_token, expiry_date, ... }
 */
async function exchangeCode(code) {
  const client = createOAuth2Client();
  const { tokens } = await client.getToken(code);
  return tokens;
}

/**
 * Fetch the authenticated user's email address and display name.
 * @param {object} tokens — from exchangeCode()
 * @returns {{ email: string, name: string }}
 */
async function getProfile(tokens) {
  const client = createOAuth2Client();
  client.setCredentials(tokens);
  const oauth2 = google.oauth2({ version: 'v2', auth: client });
  const { data } = await oauth2.userinfo.get();
  return { email: data.email, name: data.name || data.email };
}

/**
 * Return an authenticated OAuth2 client for an account stored in the DB.
 * Tokens are decrypted from the DB and the client is configured to auto-
 * persist refreshed tokens back to the DB.
 *
 * @param {object} account — row from email_accounts
 */
function getClient(account) {
  const client = createOAuth2Client();

  client.setCredentials({
    access_token:  account.oauth_access_token  ? decrypt(account.oauth_access_token)  : null,
    refresh_token: account.oauth_refresh_token ? decrypt(account.oauth_refresh_token) : null,
    expiry_date:   account.oauth_token_expiry  ? new Date(account.oauth_token_expiry).getTime() : null,
  });

  // Persist refreshed tokens back to the DB automatically
  client.on('tokens', tokens => {
    const updates = {
      id:                  account.id,
      oauth_access_token:  tokens.access_token  ? encrypt(tokens.access_token)  : account.oauth_access_token,
      oauth_refresh_token: tokens.refresh_token ? encrypt(tokens.refresh_token) : account.oauth_refresh_token,
      oauth_token_expiry:  tokens.expiry_date   ? new Date(tokens.expiry_date).toISOString() : account.oauth_token_expiry,
    };
    db.updateOAuthTokens.run(updates);
  });

  return client;
}

module.exports = { getAuthUrl, exchangeCode, getProfile, getClient };
