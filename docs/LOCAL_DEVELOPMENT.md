# Local development and database operations

## Prerequisites

- Node.js 24 or newer
- Docker Desktop for the local PostgreSQL service
- A Slack app configured as described in [SLACK_SETUP.md](SLACK_SETUP.md)

## Commands

```powershell
npm ci
Copy-Item .env.example .env
docker compose up -d db
npm run db:migrate
npm run dev
```

`compose.yaml` binds PostgreSQL to loopback port 5433 and Knot to loopback port
3000 to avoid silently using another local database or exposing development
services to the local network. The app container uses the internal `db:5432`
address and runs serialized migrations before it starts the Slack receiver.

Database migrations are immutable, ordered files in `drizzle/`. Do not modify a
migration that has been deployed. Add the next ordered SQL migration, review it
with a second engineer or explicit decision record, then apply it with
`npm run db:migrate`. Startup migrators use a PostgreSQL advisory lock so
multiple replicas cannot race the same migration set. The Phase-1 repository
does not ship a database-studio or schema-generator development server.

Run the complete PostgreSQL suite only through `npm run test:postgres`. It
requires `TEST_DATABASE_ADMIN_URL`, creates a unique temporary database, removes
Slack credentials from test child processes, and always drops the database.
Never point integration tests at the runtime Knot database.

```powershell
$env:TEST_DATABASE_ADMIN_URL='postgres://knot:knot@localhost:5433/postgres'
npm run test:postgres
```

## Safety checks

- The process refuses to start without `DATABASE_URL`, signing secret, and bot
  token.
- Runtime state is PostgreSQL-backed; the in-memory stores exist only for unit
  tests.
- Tenant-scoped repository transactions set `app.workspace_id`; the migration
  enables and forces PostgreSQL RLS policies, including for the table owner.
- The local compose database is disposable. `docker compose down --volumes`
  deletes only its named `knot-postgres` development volume.
- The Node and PostgreSQL container bases are digest-pinned. Refresh and retest
  those pins during security maintenance; reproducible does not mean
  permanently current.
- The application container runs as the non-root `node` user. A clean image
  must reach `/healthz` and `/readyz` without `.env`, `.git`, or development
  dependencies copied into the runtime layer.
