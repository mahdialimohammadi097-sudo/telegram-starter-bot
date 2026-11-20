# PR #59 integration gate — 2026-11-20

## Verified GitHub evidence

- PR #59 remains open and draft, targeting `main`.
- Comparison with `main`: 336 commits ahead, one commit behind, 101 changed files at inspection time. GitHub reports mergeable, but that is not a security sign-off.
- The sole `main` commit not in this branch's history is `51a4627841` (PR #60, read-only database diagnostics). The `src/database-diagnostics.js` file on `main` and this branch has the exact same Git blob SHA `9d8896b397b7c41538f861777d3b738053701f41`; the diagnostic functionality is already present. The companion `src/database-diagnostics.test.js` also has identical blob SHA `55aba1a578fdd422149dbc77ffd59cd7517a7e6a` on both refs.
- Five CI runs on `2d77dc2545b7912b12fb4361ee925a6dbea4c821` completed successfully (three JavaScript validation workflows and two PostgreSQL 17 restore drills).
- No PR #59 review submissions or inline review threads were recorded at inspection time. An independent financial/security review is still outstanding.


## Static financial and connection-security review (2026-11-20)

Inspected `src/ledger-posting.js`, `src/wallet-balances.js`, `src/database.js`, and `src/staging-simulation.js` directly on the draft branch:

- **Positive, code-level only:** the posting helper normalizes account IDs and eight-decimal USDT amounts, checks journal balance, serializes idempotency keys with transaction-scoped advisory locks, locks ledger account rows, checks projected AVAILABLE balances, and requires the pending-to-posted update to affect one row. This does not establish correctness of the actual deployed PostgreSQL constraints or every concurrent interleaving.
- **Positive, code-level only:** the transaction wrapper attempts rollback on errors and discards a client when rollback itself fails; wallet balance queries count only posted ledger entries.
- **Outstanding deployment-security finding:** `src/database.js` explicitly sets `ssl: false`. The private FadeHost network path and TLS support are not independently verified. Do not switch to insecure `rejectUnauthorized: false`; first obtain provider-specific TLS/private-network evidence and rehearse any connection change.
- **Outstanding release boundary:** `src/staging-simulation.js` intentionally rejects the production bot identity and requires a separate staging bot. The owner has authorized only one Telegram bot, so the isolated Telegram staging path cannot be used as written. Retain its fail-closed guard and use offline adapters and disposable databases; the final single-bot smoke test needs separate approval.
- **Review limitation:** this is a targeted static inspection, not an independent security certification, production database inspection, or authorization to move money.

## Required gates (not waived by green CI)

1. The two files changed by PR #60 were compared and are byte-identical across `main` and this branch. The one-commit ancestry difference remains; reconcile history safely before merging. Avoid force pushes or blindly merging the 336-commit draft stack.
2. Obtain independent review of double-entry ledger invariants, idempotency, concurrency, access control, and the simulated withdrawal receipt lifecycle.
3. Compare the actual production PostgreSQL catalog to the expected ledger triggers, constraints, indexes and numeric scales using read-only diagnostics. Offline PostgreSQL 17 tests do not verify production DDL.
4. Rehearse backup, migration and rollback on a disposable database with a production-compatible schema; do not mutate production.
5. Keep the single existing Telegram bot `@PROFINO1bot`. Do not provision a second bot or reuse its production token in synthetic staging.
6. Obtain explicit owner authorization for a controlled deployment only after security sign-off. Do not enable real deposits, custody, withdrawals, or settlements through this PR.

**Decision: NO-GO for production financial activation; PR remains draft.**
