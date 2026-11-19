# PR #58 — Simulated withdrawal authorization integration review

Date: 2026-11-19

## Scope

This branch is based on `feature/post-edit-session-guard` (PR #54), not `main`. The changes add active-user checks for new simulated withdrawal reservations and active-user/active-grant checks for reviewer releases. PostgreSQL regression tests cover blocked users, suspended and revoked reviewers, reviewer read access, concurrent cancellation, and serialization against reviewer revocation. All operations remain synthetic.

## Evidence

- CI run 579: https://github.com/mahdialimohammadi097-sudo/telegram-starter-bot/actions/runs/44567759723 — Node.js 22, 24 and 26 with PostgreSQL 17 succeeded.
- CI run 577: https://github.com/mahdialimohammadi097-sudo/telegram-starter-bot/actions/runs/44567511823 — all three jobs succeeded.
- PR #58: https://github.com/mahdialimohammadi097-sudo/telegram-starter-bot/pull/58

## Integration constraints and remaining gates

1. PR #58 is a draft child of PR #54. It must not be merged directly into `main` or used to activate real USDT operations.
2. PR #57 belongs to a separate financial ledger branch stack. The two stacks overlap in withdrawal and ledger files and have incompatible synthetic withdrawal schemas. Reconcile field names, states, and test fixtures explicitly before integrating; do not overwrite either schema wholesale.
3. The `submitSimulatedWithdrawal` function is an offline synthetic transport harness, not a production withdrawal authorization endpoint. It does not authenticate an external caller or sign chain transactions. A production implementation would require separate, independently reviewed authorization, transaction policy, signing isolation, and reconciliation.
4. The concurrency tests prove the tested interleavings only. They do not establish comprehensive absence of deadlocks, starvation, or all possible race conditions.
5. Before any financial launch: independent security review, production migration rehearsal, backup/restore verification, financial reconciliation, incident response and rollback procedures, legal/compliance review, and explicit owner approval.

## Release decision

**NO-GO for live deposits, withdrawals, custody, or profit settlement.** Continue isolated branch testing and integration review.
