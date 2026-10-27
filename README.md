# spindle

Spindle syncs all your mailboxes into one unified inbox you can drive from the keyboard. Use the hosted service or run it on your own server.

The 2.0 rewrite has a local development foundation. Authentication and mail synchronization are not implemented yet. The visual design system will be imported from Claude Design later.

See the [confirmed decisions](docs/decisions.md), [rebuild brief](REBUILD_BRIEF.md), and [task checklist](REBUILD_TASKS.md).

## Local development

Install Node 24 LTS (see `.nvmrc`), npm, and Docker with Compose. Your user needs access to the Docker daemon.

```bash
npm ci
cp .env.example .env
npm run db:up
npm run dev
```

Keep an existing `.env` rather than overwriting it. The example credentials are for a loopback-only development database. Never reuse them for hosting.

Open **http://127.0.0.1:5173**. One command starts Vite, the Fastify API, and a separate pg-boss worker. Vite forwards `/api` to the local API, so the browser uses one origin. The placeholder page checks database readiness; it is not the final product design.

Postgres listens on `127.0.0.1:15432`, the API on `127.0.0.1:3000`, and Vite on `127.0.0.1:5173`. The worker initializes pg-boss's own versioned queue schema; application/user/mail schema migrations come with the next slice. No mail handlers run yet.

If Docker reports permission denied, start the development database with `sudo docker compose up -d --wait` in your terminal, then run `npm run dev` normally. Do not run npm or the application as root.

Stop the app with Ctrl-C. `npm run db:down` stops Postgres and preserves its named volume. Do not remove that volume when it contains data you need.

## Checks and entry points

```bash
npm run check    # lint/format check, typecheck, tests, builds
npm run format   # apply formatting
```

- `apps/web`: responsive React/Vite frontend with temporary native styling.
- `apps/server/src/start.ts`: API startup; `/api/health` tests liveness and `/api/ready` tests database connectivity. Readiness returns 503 without database details during an outage.
- `apps/server/src/worker.ts`: separate Postgres-backed queue process with graceful shutdown.
- `npm run build`: emits `apps/web/dist` and `apps/server/dist`.
- `npm start` and `npm run worker`: run the compiled API and worker. The API currently serves API routes only; production web hosting/TLS will be added before deployment.

CI uses Node 24 and runs the same checks. Configure secrets only when their owning features are implemented; no OAuth credentials, encryption keys or mail accounts are needed for this foundation.
