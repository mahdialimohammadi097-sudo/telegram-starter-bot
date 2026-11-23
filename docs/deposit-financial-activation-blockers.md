# PROFINO — live USDT activation blockers (NOT APPROVED)

This review covers the integrated **read-only** deposit preflight and evidence-table migration in draft PR #114. Passing CI is not a production authorization.

## Verified from the reviewed code

- `scripts/deposit-preflight.js` opens a repeatable-read, read-only transaction, inspects schema and active deposit wallet uniqueness, then rolls back.
- `src/deposit-schema-audit.js` checks required columns, numeric precision, validated foreign keys, selected unique indexes and selected CHECK constraint patterns. Regex matching is **not** a proof of logical equivalence of PostgreSQL expressions.
- `migrations/20261123_verified_deposit_evidence.review.sql` proposes additive evidence storage only; it does not implement chain monitoring, deposit crediting, or withdrawals.
- CI PostgreSQL restore drills use disposable CI databases. They do **not** prove that the actual FadeHost production database backup can be restored.

## Mandatory evidence still required before any live deposit

1. **Production backup:** independently verify a recent encrypted FadeHost production backup and successfully restore it to an isolated nonproduction PostgreSQL 17 target. Capture sanitized timestamps, versions, and success/failure; never expose secrets or user records.
2. **Production catalog:** run the original read-only FadeHost schema audit and stronger deposit preflight using a dedicated least-privilege read-only role. Review actual SQL definitions, index predicates, and privilege grants manually.
3. **Chain evidence:** independently test the selected USDT token contract and chain ID, event identity, confirmations/reorg handling, event replay, mismatched deposit addresses, wrong tokens, malformed amounts, and RPC outage recovery. Do not enable a listener or crediting handler for this review.
4. **Accounting:** demonstrate atomic, balanced double-entry postings; exact USDT base-unit conversion; idempotent transaction keys; duplicate-event and concurrency rejection; failed-posting rollback; no negative available balances; and reconciliation against independently verified chain evidence. The current ledger parser uses **8 decimal places** (`src/ledger-safety.js`); independently verify the configured chain token's actual `decimals` and implement/test a lossless integer conversion between on-chain `amount_base_units` and ledger units before any credit. Never assume the token uses 8 decimals, never round deposits, and reject unsupported precision or mismatched token contracts.
5. **Authorization:** demonstrate admin authentication and least privilege, explicit approval boundaries, audit trail integrity, safe handling of credentials, and operational monitoring. Ensure a successful schema check cannot turn on deposits.
6. **Operations:** record reviewed deployment SHA, tested release/rollback procedure, alerting and incident response. Production migration requires **separate owner authorization** and a controlled maintenance window; financial activation requires a second explicit owner authorization after security/accounting sign-off.

## Release decision

**BLOCKED** until all six gates are independently evidenced and the owner explicitly authorizes the appropriate action. No merging to `main`, no production schema writes, no live deposit acceptance, no balance credits, and no withdrawals are authorized by this document.
