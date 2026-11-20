# PR #59 integration gate — 2026-11-19

## Verified GitHub topology

- PR #54: `feature/post-edit-session-guard` -> `main`; open, not draft, not merged.
- PR #58: `feature/withdrawal-auth-integration-20261119` -> `feature/post-edit-session-guard`; open draft, not merged.
- PR #59: **same head branch as PR #58** -> `main`; open draft, not merged.
- PR #57: `audit/ledger-release-gates-20261119` -> `feature/integrated-postgres-matrix`; separate open draft stack, not merged.

**Important:** PR #58 and #59 share a head branch. Changes pushed to this branch affect both reviews. PR #59 spans the base stack plus the authorization work, and must not be treated as an independent, isolated change. The separate PR #57 stack cannot be assumed incorporated just because PR #59 CI passes.

## Automated verification

Commit `4a916d40`: three Validate JavaScript workflow runs and two PostgreSQL 17 restore drill workflow runs all completed successfully (5/5). This verifies the current branch's configured automated checks, **not** independent release authorization.

## Required before merging

1. Review the complete diff of PR #59 against `main`, including its inherited changes from PR #54, with a security reviewer independent of the author.
2. Resolve the relationship between PR #54, #58, and #59; avoid merging overlapping stacks twice or accidentally overwriting withdrawal authorization.
3. Reconcile PR #57 ledger-safety changes by comparing actual file diffs, migrations and test fixtures, not by wholesale copying the narrower synthetic withdrawal schema.
4. Verify migration, rollback and ledger reconciliation against a disposable PostgreSQL 17 database. Do not use production credentials or production data.
5. Confirm production configuration disables simulation writers; the single production bot `@PROFINO1bot` must never be used as an isolated staging bot.
6. Obtain independent security approval and a separate, explicit owner authorization before any production deployment or live financial operation.

**Decision: HOLD.** Keep PR #59 draft; no merge, deployment, real custody, transfers or settlement.
