# FadeHost production schema audit — controlled execution

Status: **NOT DEPLOYED**. This document does not authorize merging PR #81, changing the production bot, or enabling deposits.

## Preflight

1. Obtain explicit owner approval for a **code-only deployment** to the existing `telegram-bot` service. Approval to deploy diagnostics is **not** approval to receive or transfer real USDT.
2. Review PR #81 and verify both CI checks pass. Verify the PR contains only the audit script, its tests, the workflow and CI dependency fix, and this guide.
3. Before merging, verify the service's current `main` commit, runtime health, database connection and a rollback path. GitHub pushes to `main` auto-deploy on FadeHost.
4. Do not copy `DATABASE_URL` or any credentials into a schedule, chat, log or PR.

## Running after approved deployment

1. Confirm the FadeHost deployed commit contains `scripts/fadehost-schema-audit.js`.
2. In **telegram-bot → Schedules**, add a temporary UTC cron schedule using exactly:
   `node scripts/fadehost-schema-audit.js`
3. The scheduler is recurring, not a guaranteed immediate one-shot. Select the next available UTC minute with enough lead time to save; record the schedule and remove it after its first execution. Avoid duplicating the existing cleanup schedule. Execution time limit: 60 seconds.
4. Read the **last answer** in Schedules. Copy only sanitized JSON output, never environment variables or credentials. The script has a single 8-second statement timeout and an 8-second connection timeout.
5. Delete the temporary schedule once it has run, whether successful or failed, to avoid recurring database checks.

## Interpreting output

- `ready: false, missing: [...]`: expected columns or uniqueness checks are missing. This is a **blocker**, not permission to apply migrations blindly.
- `ready: true, missing: []`: only the script's limited table/column/unique-index inventory passed. It does **not** validate ledger correctness, chain receipts, security, ownership, reconciliation or legal readiness.
- `error: DATABASE_URL_NOT_CONFIGURED`: connection environment not available.
- `error: READ_ONLY_AUDIT_FAILED`: audit could not complete. The `code` is a sanitized SQLSTATE or UNKNOWN; investigate privately.

## Hard boundaries

The script executes only metadata SELECT statements in a PostgreSQL READ ONLY transaction and uses read-only session options. It does not insert, update, delete, migrate, approve deposits, start Telegram polling or move USDT. Real financial operations remain disabled until independent security and accounting verification and explicit owner approval.
