# Wallet ownership production audit — controlled runbook

Status: REVIEW ONLY. Do not merge or deploy this branch to production just to run an audit.

## Prerequisites
- Use an independently provisioned **SELECT/catalog-only** PostgreSQL role.
- Provide its connection URL as `PROFINO_AUDIT_DATABASE_URL` only through a secret manager. Never paste credentials into chat, logs or terminal history.
- The audit file `scripts/wallet-ownership-catalog-audit.js` must be present in the **same verified checkout** that runs the command. The production `main` deployment does not necessarily contain this draft PR file.
- Do not reuse the production application `DATABASE_URL` or an elevated `postgres` login.
- Do not create tables, change permissions, migrate, backfill or enable financial features.

## Execute in an isolated checkout with approved network access
```sh
node scripts/wallet-ownership-catalog-audit.js
```
The script opens a repeatable-read read-only transaction, queries metadata only, rolls back, and emits JSON. It exits 2 for missing structural requirements and 1 for query/connection failure. Exit 0 is **structural inspection only**, not financial release approval.

## Evidence to retain
Record audit timestamp, audited database identifier (nonsecret), commit SHA, JSON output, and exit code. Redact all connection strings, hostnames, user identifiers and secrets before sharing. Compare the wallet columns and constraints with the historical verification code; a missing history table is a blocker, not an instruction to apply migrations.

## Remaining release blockers
- Independent verification of historical address assignment and non-reassignment.
- Independent canonical BSC RPC and finality checks.
- Tested restore of an actual production backup into an isolated environment.
- Ledger reconciliation and owner-approved production change/release plan.
- Explicit owner financial activation authorization after security/accounting sign-off.
