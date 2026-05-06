/**
 * outlook.js — Outlook / Microsoft Graph OAuth2 service.
 *
 * Uses the Microsoft identity platform (v2 endpoint) directly via fetch —
 * no MSAL dependency needed for a straightforward auth-code flow.
 *
 * Scopes requested:
 *   Mail.Read, Mail.ReadWrite, Mail.Send, User.Read, offline_access
 *
 * Token storage mirrors gmail.js: access + refresh tokens are AES-encrypted
 * in the email_accounts table, auto-refreshed on expiry.
 */

const { encrypt, decrypt } = require('../../utils/crypto');
const db = require('../../db/queries');

const CLIENT_ID     = () => process.env.OUTLOOK_CLIENT_ID;
const CLIENT_SECRET = () => process.env.OUTLOOK_CLIENT_SECRET;
const TENANT_ID     = () => process.env.OUTLOOK_TENANT_ID || 'common';
const REDIRECT_URI  = () => `${process.env.APP_URL || 'http://localhost:3000'}/api/oauth/outlook/callback`;

const SCOPES = [
  'https://graph.microsoft.com/Mail.Read',
  'https://graph.microsoft.com/Mail.ReadWrite',
  'https://graph.microsoft.com/Mail.Send',
  'https://graph.microsoft.com/User.Read',
  'offline_access',
].join(' ');

const TOKEN_URL = () =>
  `https://login.microsoftonline.com/${TENANT_ID()}/oauth2/v2.0/token`;

// ── Auth URL ──────────────────────────────────────────────────────────────────

function getAuthUrl(state) {
  const params = new URLSearchParams({
    client_id:     CLIENT_ID(),
    response_type: 'code',
    redirect_uri:  REDIRECT_URI(),
    response_mode: 'query',
    scope:         SCOPES,
    state,
    prompt:        'select_account',
  });
  return `https://login.microsoftonline.com/${TENANT_ID()}/oauth2/v2.0/authorize?${params}`;
}

// ── Code exchange ─────────────────────────────────────────────────────────────

async function exchangeCode(code) {
  const body = new URLSearchParams({
    client_id:     CLIENT_ID(),
    client_secret: CLIENT_SECRET(),
    code,
    redirect_uri:  REDIRECT_URI(),
    grant_type:    'authorization_code',
    scope:         SCOPES,
  });

  const res = await fetch(TOKEN_URL(), {
    method:  'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });

  const data = await res.json();
  if (!res.ok) {
    throw new Error(data.error_description || data.error || 'Token exchange failed');
  }

  return {
    access_token:  data.access_token,
    refresh_token: data.refresh_token,
    expiry_date:   data.expires_in ? Date.now() + data.expires_in * 1000 : null,
  };
}

// ── Profile fetch ─────────────────────────────────────────────────────────────

async function getProfile(tokens) {
  const res = await fetch('https://graph.microsoft.com/v1.0/me', {
    headers: { Authorization: `Bearer ${tokens.access_token}` },
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error?.message || 'Failed to fetch profile');
  return {
    email: data.mail || data.userPrincipalName,
    name:  data.displayName || data.mail || data.userPrincipalName,
  };
}

// ── Token refresh ─────────────────────────────────────────────────────────────

async function refreshTokens(refreshToken) {
  const body = new URLSearchParams({
    client_id:     CLIENT_ID(),
    client_secret: CLIENT_SECRET(),
    refresh_token: refreshToken,
    grant_type:    'refresh_token',
    scope:         SCOPES,
  });

  const res = await fetch(TOKEN_URL(), {
    method:  'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });

  const data = await res.json();
  if (!res.ok) {
    throw new Error(data.error_description || data.error || 'Token refresh failed');
  }

  return {
    access_token:  data.access_token,
    refresh_token: data.refresh_token || refreshToken, // MS may not return a new one
    expiry_date:   data.expires_in ? Date.now() + data.expires_in * 1000 : null,
  };
}

// ── Authenticated fetch ───────────────────────────────────────────────────────

/**
 * Perform a Graph API call, auto-refreshing the access token if it has expired
 * or if we receive a 401. Persists new tokens to the DB.
 *
 * @param {object} account   — email_accounts row
 * @param {string} url       — full Graph API URL
 * @param {object} [options] — fetch options (method, headers, body, etc.)
 * @returns {Response}
 */
async function graphFetch(account, url, options = {}) {
  let accessToken  = account.oauth_access_token  ? decrypt(account.oauth_access_token)  : null;
  const refreshTok = account.oauth_refresh_token ? decrypt(account.oauth_refresh_token) : null;
  const expiry     = account.oauth_token_expiry  ? new Date(account.oauth_token_expiry).getTime() : null;

  // Proactively refresh if within 2 minutes of expiry
  const needsRefresh = !accessToken || (expiry && Date.now() > expiry - 120_000);

  if (needsRefresh && refreshTok) {
    const fresh = await refreshTokens(refreshTok);
    accessToken = fresh.access_token;

    // Persist refreshed tokens
    db.updateOAuthTokens.run({
      id:                  account.id,
      oauth_access_token:  encrypt(fresh.access_token),
      oauth_refresh_token: encrypt(fresh.refresh_token),
      oauth_token_expiry:  fresh.expiry_date ? new Date(fresh.expiry_date).toISOString() : account.oauth_token_expiry,
    });

    // Update in-memory object so a 401 retry below uses the fresh token
    account.oauth_access_token = encrypt(fresh.access_token);
  }

  const headers = {
    Authorization:  `Bearer ${accessToken}`,
    'Content-Type': 'application/json',
    ...(options.headers || {}),
  };

  const response = await fetch(url, { ...options, headers });

  // If we still get a 401 and we have a refresh token, try once more
  if (response.status === 401 && refreshTok && !needsRefresh) {
    const fresh = await refreshTokens(refreshTok);
    db.updateOAuthTokens.run({
      id:                  account.id,
      oauth_access_token:  encrypt(fresh.access_token),
      oauth_refresh_token: encrypt(fresh.refresh_token),
      oauth_token_expiry:  fresh.expiry_date ? new Date(fresh.expiry_date).toISOString() : account.oauth_token_expiry,
    });
    const retryHeaders = {
      Authorization:  `Bearer ${fresh.access_token}`,
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    };
    return fetch(url, { ...options, headers: retryHeaders });
  }

  return response;
}

module.exports = { getAuthUrl, exchangeCode, getProfile, graphFetch };
