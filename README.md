# AVC Cloud WMS

Phase 0 foundation plus Milestone 1A intake and auditable job cards for a two-location automotive workshop system. The API implements protected customer/vehicle lookup and creation, intake job creation, a guarded start-inspection command, and read-only job board/detail. Staff OIDC provider selection and browser sign-in are still blocked; the deployed verifier rejects all bearer tokens until configured.

## Requirements

- Node.js 24 and pnpm 11.25.0
- PostgreSQL 17 or 18 (the provided `compose.yaml` uses 17; local validation used 18)

## Local setup

1. `pnpm install --frozen-lockfile`
2. Copy `.env.example` to `.env` and set `DATABASE_URL` for your local database. Never commit `.env`.
3. Start PostgreSQL, for example `docker compose up -d db` if Docker is installed.
4. `pnpm migrate:up`
5. `pnpm build`
6. `pnpm start`

Open `http://127.0.0.1:3000/` for the shell. `GET /health/live` checks the process; `GET /health/ready` checks PostgreSQL and returns 503 when it cannot connect. Development API watch mode: `pnpm dev`. The served web shell is the latest built `apps/web/dist`; rebuild the web package after edits.

The PWA provides responsive board/detail views with loading, empty and error states. It does not cache customer/API responses. Without a selected and configured identity provider, it shows an access error rather than live records. The test verifier exists only through dependency injection in automated tests; there is no development backdoor or seeded staff login.

## Checks

`pnpm format:check`, `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build`, and `pnpm migrate:validate`. Run `pnpm format` to apply formatting. `migrate:validate` requires a database and fails if a migration is pending or an applied file changed.

`pnpm test` requires a **dedicated** PostgreSQL test database in `TEST_DATABASE_URL`. See `.env.test.example`; tests truncate AVC tables in that database. Do not point it at development or production data. CI provides a disposable PostgreSQL service. Run `pnpm migrate:up` against your development `DATABASE_URL` after pulling new migrations (0003 adds branches, quotes, approvals, evidence and the integration outbox).

## Layout

- `apps/server`: Fastify API, migration runner, SQL migrations and future seeders.
- `apps/web`: React staff shell, built as static assets served by the API.
- `docs`: product, architecture and domain decisions.
- `.github/workflows`: CI checks.
- `App Requirements`: supplied client source documents, kept locally and not committed (the repo is public).

There are no production credentials or live customer records in this repository. OIDC provider, advisor role split and intake custody details require AVC decisions. Zoho Books, SMS/WhatsApp, object storage and payment gateway remain out of scope.
