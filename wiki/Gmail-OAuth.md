# Gmail OAuth

Connecting Gmail accounts uses OAuth 2.0 via the Gmail API. No Gmail password is ever stored -- only an encrypted refresh token.

## 1. Create a project in Google Cloud Console

Go to [console.cloud.google.com](https://console.cloud.google.com) and create a new project, or select an existing one.

## 2. Enable the Gmail API

Go to **APIs and Services -> Library**, search for **Gmail API**, and enable it.

## 3. Create OAuth credentials

1. Go to **APIs and Services -> Credentials**
2. Click **Create Credentials -> OAuth 2.0 Client ID**
3. Set the application type to **Web application**
4. Under **Authorized redirect URIs**, add:
   ```
   {APP_URL}/api/oauth/gmail/callback
   ```
   Replace `{APP_URL}` with your actual public URL, e.g. `https://mail.yourdomain.com/api/oauth/gmail/callback`
5. Click **Create** and copy the client ID and client secret

## 4. Add credentials to .env

```
GMAIL_CLIENT_ID=your_client_id
GMAIL_CLIENT_SECRET=your_client_secret
```

## 5. Configure the OAuth consent screen

Go to **APIs and Services -> OAuth consent screen** and fill in the required fields. If your app is in **Testing** mode, only users you explicitly add as test users will be able to connect. To allow any Google account, publish the app or add users under **Test users**.

## Notes

- Spindle requests the `gmail.readonly`, `gmail.send`, and `gmail.modify` scopes
- Refresh tokens are encrypted with AES-256-GCM before being stored in the database
- If a token expires, Spindle refreshes it automatically using the stored refresh token
