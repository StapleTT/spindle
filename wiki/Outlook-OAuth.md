# Outlook OAuth

Connecting Outlook and Microsoft 365 accounts uses OAuth 2.0 via the Microsoft Graph API. No password is ever stored -- only an encrypted refresh token.

## 1. Register an app in Azure

1. Go to [portal.azure.com](https://portal.azure.com)
2. Navigate to **Azure Active Directory -> App registrations**
3. Click **New registration**
4. Give the app a name (e.g. "Spindle")
5. Under **Supported account types**, select **Accounts in any organizational directory and personal Microsoft accounts** (or restrict as needed)
6. Under **Redirect URI**, select **Web** and enter:
   ```
   {APP_URL}/api/oauth/outlook/callback
   ```
   Replace `{APP_URL}` with your actual public URL

## 2. Create a client secret

1. Go to **Certificates and secrets -> New client secret**
2. Set an expiry and click **Add**
3. Copy the secret value immediately -- it will not be shown again

## 3. Add API permissions

1. Go to **API permissions -> Add a permission -> Microsoft Graph -> Delegated permissions**
2. Add the following permissions:
   - `Mail.ReadWrite`
   - `Mail.Send`
   - `offline_access`
3. Click **Grant admin consent** if prompted (required for `offline_access` in some tenants)

## 4. Copy credentials to .env

From the app's **Overview** page, copy:

```
OUTLOOK_CLIENT_ID=your_application_client_id
OUTLOOK_CLIENT_SECRET=your_client_secret_value
OUTLOOK_TENANT_ID=common
```

Use `common` as the tenant ID to allow both personal Microsoft accounts and work/school accounts. Replace with your specific tenant ID to restrict to your organization only.

## Notes

- Spindle uses raw fetch against the Microsoft identity v2 endpoint -- no MSAL dependency
- Refresh tokens are encrypted with AES-256-GCM before being stored in the database
- Spindle proactively refreshes tokens within 2 minutes of expiry and retries on 401
- Client secrets expire based on the duration you set in Azure -- update `.env` and restart Spindle when you rotate the secret
