# spindle

Spindle syncs all your mailboxes into one unified inbox you can drive from the keyboard. Use the hosted service or run it on your own server.

The 2.0 rewrite supports invite-only signup, verified-email/password login, recovery, private IMAP connections, background sync, a unified inbox and a cached message reader with isolated HTML and optional images. The visual design system will be imported from Claude Design later.

See the [confirmed decisions](docs/decisions.md), [rebuild brief](REBUILD_BRIEF.md), and [task checklist](REBUILD_TASKS.md).

## Local development

Install Node 24 LTS (see `.nvmrc`), npm, and Docker with Compose. Your user needs access to the Docker daemon.

```bash
npm ci
cp .env.example .env
# Set AUTH_SECRET in .env to a random value: openssl rand -base64 48
# Set MAIL_ENCRYPTION_KEYS using the key-generation command in docs/imap.md.
npm run db:up
npm run db:migrate
npm run auth:invite -- you@example.com --admin
npm run dev
```

Keep an existing `.env` rather than overwriting it. The example credentials are for a loopback-only development database. Never reuse them for hosting.

Replace `you@example.com` with the email you want to use. `--admin` explicitly designates the initial admin; the first person to register does not automatically become admin. For subsequent users, omit `--admin`.

With the example Mailpit settings, open **http://127.0.0.1:8025** to read captured invitation, verification, and recovery emails. Follow the invitation to **http://127.0.0.1:5173**, create your account, open the verification email, and sign in. Use `127.0.0.1` consistently: it must match `APP_URL` for cookies and origin checks. For real delivery from `noreply@spindle.staplett.xyz`, see [Resend setup and receipt checks](docs/resend.md).

`npm run dev` starts Vite, the Fastify API, and a separate pg-boss worker. Vite forwards `/api` to the API, so the browser uses one origin. Forms use temporary accessible styling pending Claude Design.

Postgres listens on `127.0.0.1:15432`, the API on `127.0.0.1:3000`, Vite on `127.0.0.1:5173`, and Mailpit SMTP on `127.0.0.1:1025`. The worker owns pg-boss's queue schema and IMAP synchronization; `npm run db:migrate` applies versioned application migrations. After signing in, choose **Connect IMAP account**. See [IMAP setup, coverage and recovery](docs/imap.md).

Click a message to read it. The API also starts isolated content at `http://localhost:3001` for the default app origin. Images start blocked; **Display images** enables them for the selected message. See [reader setup, cache limits and hosted content configuration](docs/reader.md).

Choose **Compose** to write rich or plain text with To/Cc/Bcc and autosaved private drafts. **Local drafts** reopens them. Conflicts preserve edits from both tabs; provider Drafts synchronization remains future work. Configure **Outgoing SMTP** under an account to enable **Send**, then review **Outbox** for acceptance, cancellation, failure or uncertainty. See [SMTP setup and sending](docs/sending.md). See [composer and draft recovery](docs/compose.md).

If Docker reports permission denied, start the development database with `sudo docker compose up -d --wait` in your terminal, then run `npm run dev` normally. Do not run npm or the application as root.

Stop the app with Ctrl-C. `npm run db:down` stops Postgres and preserves its named volume. Do not remove that volume when it contains data you need.

## Checks and entry points

```bash
npm run check    # lint/format check, typecheck, tests, builds
npm run format   # apply formatting
npm run test:integration # isolated Postgres auth and IMAP tests; role needs CREATEDB
npm exec -- playwright install chromium # once, for browser tests
npm run test:browser
```

- `apps/web`: responsive React/Vite frontend with temporary native styling.
- `apps/server/src/start.ts`: API startup; `/api/health` tests liveness and `/api/ready` tests database connectivity. Run migrations before starting. `/api/me` returns only the authenticated, verified user's profile.
- `apps/server/src/worker.ts`: separate Postgres-backed queue process with graceful shutdown.
- `npm run build`: emits `apps/web/dist` and `apps/server/dist`.
- `npm start` and `npm run worker`: run the compiled API and worker. The API currently serves API routes only; production web hosting/TLS will be added before deployment.

CI uses Node 24, Postgres, synthetic IMAP mail and Chromium to run the same checks. See [authentication setup and behavior](docs/authentication.md) and [IMAP setup](docs/imap.md) for configuration and boundaries. Automated checks need no real provider accounts or OAuth credentials.
