# Synthetic withdrawal schema compatibility matrix

Date: 2026-11-19

Sources inspected directly:
- `test-support/withdrawal-schema.js` at `feature/post-edit-session-guard` (PR #54)
- `test-support/withdrawal-schema.js` at `audit/ledger-release-gates-20261119` (PR #57)

| Schema element | PR #54 | PR #57 | Integration rule |
| --- | --- | --- | --- |
| `simulation_reviewers` | `user_id`, `active` | Same | Preserve; enforce active reviewer AND active user in authorization queries |
| `simulation_withdrawals.status` | `reserved`, `cancelled`, `pending_receipt`, `paid` | `reserved`, `cancelled` | Preserve all four states; never replace with the narrower check |
| `submitted_hash` | Unique, nullable | Missing | Preserve synthetic submission identity and replay semantics |
| `simulation_payload` | `bytea` | Missing | Preserve synthetic transport recovery |
| `destination` | Present | Missing | Preserve destination-bound validation and immutable replay matching |
| `payout_event` | Unique | Missing | Preserve synthetic receipt uniqueness |
| `payout_id` | Unique journal FK | Missing | Preserve settlement linkage |
| `clearing_id` | Ledger account FK | Missing | Preserve clearing-account linkage |
| `cancelled_by_reviewer`, `release_id` | Present | Present | Preserve both and journal idempotency |
| `UNIQUE(user_id, request_key)` | Present | Present | Preserve request deduplication |

## Observed constraints

PR #54 enforces the presence of `submitted_hash` in `pending_receipt` and `paid` states. It also enforces that `payout_event`, `payout_id`, and `clearing_id` are all present exactly when status is `paid`. PR #57 does not have these constraints because its schema has no submission/receipt lifecycle.

## Integration checklist

- [x] Inspect both schema definitions directly.
- [x] Document the exact state and column differences.
- [x] Port active customer and active reviewer authorization checks into PR #54-derived PR #58.
- [x] Verify PR #58 authorization and concurrency tests under Node 22/24/26 with PostgreSQL 17 (CI run 579).
- [ ] Rebase/integrate the ledger-safety changes from PR #57 without overwriting the PR #54 schema.
- [x] Exercise the extended withdrawal schema against PostgreSQL in integrated synthetic tests; staging adapters now use the real catalog compatibility query.
- [x] Add negative tests for missing payout columns and missing payout-state constraints.
- [x] Add an explicit migration rehearsal from the narrower legacy schema to the four-state schema; tested by `src/withdrawal-migration-rehearsal.postgres.test.js` against disposable PostgreSQL, not production.
- [x] Run the current integrated PostgreSQL CI and restore drill (commit `54f40b86`, all five workflow runs successful on 2026-11-19).\n- [ ] Independently verify final merged branch, reconciliation, and release checks after dependency integration.
- [ ] Independent security review, migration/rollback rehearsal, backup/restore, and explicit production approval.

**Release decision: NO-GO** for live financial operations. This matrix describes synthetic test infrastructure, not a production schema migration plan.
