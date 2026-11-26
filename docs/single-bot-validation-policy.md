# Single-bot validation policy (PROFINO)

The owner requires exactly one Telegram bot: `@PROFINO1bot`. Do not create a second Telegram bot, reuse the production bot token in staging, or enable isolated-staging simulation writers on the production bot.

## Validation without a second bot

1. Keep the current cumulative review PR #226 in draft and do not merge or deploy it to production merely because CI passes. PR #59 is historical; do not independently merge overlapping review branches.
2. Run `npm test` and `npm run test:postgres` against a **disposable, isolated PostgreSQL 17 test database**, never production. The PostgreSQL integration suite uses synthetic identities and balances.
3. Verify the GitHub Actions JavaScript matrix and PostgreSQL restore drills are green for the **same final commit SHA**.
4. Use the existing mocked Telegram adapters and synthetic financial tests to exercise commands, investment lifecycle, withdrawal reservation, submission, receipt, cancellation, reviewer authorization, concurrency, idempotency and reconciliation. These are not a live Telegram end-to-end test.
5. Review migration compatibility and financial ledger invariants independently before any merge. Preserve production data and avoid any real transfer or settlement.
6. For the final **single-bot** Telegram smoke test, prepare a separate approved maintenance/release plan for the existing bot, with backup, rollback, explicit authorization and no simultaneous competing polling/webhook consumers. Do not execute that smoke test from CI or the isolated simulation preflight.

## Evidence and release gate

Record the final commit SHA, CI run URLs, PostgreSQL test results, schema/migration review, security sign-off, and the separately authorized live smoke-test outcome. A green CI suite alone does **not** establish live release readiness. Do not enable real deposits, withdrawals, custody or payouts without explicit owner approval after all gates pass.

The existing `scripts/staging-simulation-preflight.js` intentionally requires a different authenticated Telegram bot and **must not** be run with `@PROFINO1bot`. Its failure under the single-bot policy is expected; never weaken this fail-closed guard to make it pass.
