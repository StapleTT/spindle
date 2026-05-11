# Installation

## 1. Clone and install

```bash
git clone https://github.com/StapleTT/spindle.git
cd spindle
npm install
```

## 2. Configure environment variables

```bash
cp .env.example .env
```

Open `.env` and fill in all required values. See [Environment Variables](Environment-Variables.md) for a full reference.

## 3. Start the server

```bash
npm start
```

The server starts on `http://localhost:3000` by default, or on the `PORT` set in `.env`.

For production use with auto-start and crash recovery, see [Production Deployment](Production-Deployment.md).

## 4. Create the first account

The first registered user is automatically granted admin privileges. Because registration requires an invite code, generate one via the API before navigating to the app:

```bash
curl -s -X POST http://localhost:3000/api/admin/invite-codes
```

The response contains a `XXXX-XXXX-XXXX` code ready to use. Navigate to `/auth`, register with it, and you are in. All subsequent invite codes can be generated and managed from the admin panel in the sidebar.
