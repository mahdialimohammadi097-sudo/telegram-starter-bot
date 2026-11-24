# Isolated staging simulation: operational readiness

The production bot `@PROFINO1bot` and the production database must not be used for synthetic financial testing. PR #59 remains a draft; do not deploy it to the production service.

## Required independent resources

1. Create a **separate Telegram test bot** via BotFather and keep its token only in staging secrets.
2. Create a **new PostgreSQL 17 database** with no production users, wallets, transactions, or secrets. Do not clone production personal or financial data.
3. Apply the approved ledger and simulation schemas to that isolated database. This PR does not auto-create the financial schema.
4. With staging database administrator access, mark only the independent database:
   `ALTER DATABASE your_staging_db SET profino.environment = 'isolated-staging';`
   Reconnect afterward; verify `SELECT current_database(), current_setting('profino.environment', true);`. Preflight additionally checks the database-wide `pg_db_role_setting` entry with `setrole=0`; session-only or role-only markers are rejected.
5. Set staging-only environment variables:
   - `PROFINO_DEPLOYMENT_ENV=staging`
   - `PROFINO_SIMULATION_MODE=isolated-staging`
   - `PROFINO_STAGING_BOT_USERNAME=<actual separate bot username>`
   - `PROFINO_STAGING_DATABASE_NAME=<actual separate database name>` (name must contain a separate underscore-delimited `staging`, `test`, or `sandbox` segment; this is a supplementary fail-closed check, **not** proof of isolation)
   - `PROFINO_PRODUCTION_DATABASE_NAME=<actual production database name>` (recommended extra guard: must not equal staging database; never use production credentials in staging)
   - `TELEGRAM_BOT_TOKEN=<staging bot token>`
   - `DATABASE_URL=<isolated staging PostgreSQL URL>`
6. Run `node scripts/staging-simulation-preflight.js` **in staging**. It only reads the database and calls Telegram `getMe`; it does not send messages or post ledger entries. A PASS confirms identity, marker, required tables and adapter availability, **not** end-to-end correctness.
7. Only after PASS, launch the staging service and exercise `/start`, investment previews, test investment, test withdrawal, customer cancellation, reviewer release, and ledger reconciliation using **synthetic test balances**. Record the results before marking the feature ready.

No real deposits, withdrawals, transfers, or payouts are authorized by this setup. Missing or mismatched identities cause startup/preflight to fail closed. The staging database must be isolated at the hosting/network permission layer as well as by these application checks.
