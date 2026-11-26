# Priority 5 ledger — review checkpoint (2026-11-25)

**NO-GO for real customer funds.** This branch is a review candidate only. Do not merge to main, deploy, enable real financial commands, or run review fixture DDL on a real database. Test success is not evidence of asset backing or authorization.

## Exact tested baseline
- Integration baseline: `36b6285b8ca53198ccb38dd554ba76812af91ac1`.
- Combined ledger commit `b0f170d4b62b20b36b5aaf4fdf89bd5bd71db1c8`, PR #218: nine of nine GitHub checks successful.
- [Node.js 22 / PostgreSQL 17 log](https://github.com/mahdialimohammadi097-sudo/telegram-starter-bot/actions/runs/45685437323/job/139456689430): 545 passed, zero failed, cancelled or skipped; focused suite 111 passed, zero failed, cancelled or skipped (overlapping subset).
- [Node.js 26 log](https://github.com/mahdialimohammadi097-sudo/telegram-starter-bot/actions/runs/45685437463/job/139456689952): 545 passed, zero failed or skipped.
- The new trigger catalog audit from #221 is a descendant of that exact combined commit. Its standalone concurrency check passed, but that workflow does not establish execution of the new trigger tests. Full exact-head matrix required.
- #218 is the cumulative review vehicle; #221 overlaps it. Do not merge both independently. No production migration or real financial activation.

## Code and test scope
| Control | Evidence |
|---|---|
| Balanced, exact eight-decimal journals | Posting service + isolated PostgreSQL fixture |
| Transaction boundaries and failure recovery | Explicit transaction savepoint, rollback and commit checks |
| Concurrent spending and replay | Advisory key lock, ordered account locks, READ COMMITTED guard; available, invested, withdrawal hold tests |
| Confirmed deposit identity | Domain service rejects conflicting journal identities; separate test-only SQL review fixture |
| Posted record immutability | Isolated trigger contract and synthetic compensating journal tests |
| Internal ledger reconciliation | Count-only read-only snapshot; detects invalid entries, unbalanced journals and negative customer accounts |
| Simulated obligations | Per-user invested/held amounts compared with independent simulated request tables |
| Custody comparison | Offline arithmetic only, not proof of backing or completeness |
| Trigger catalog shape | New read-only audit, requires exact-head PostgreSQL test evidence; does not verify function bodies |

## Mandatory open gates
1. Exact cumulative head CI, independent review of complete dependency diff, and integration checks before any financial changes leave isolation.
2. Compare current target PostgreSQL catalog, full trigger bodies/helper functions, constraints, indexes, runtime and financial-writer role grants, ownership, search path and RLS with the reviewed contract. A shape match alone is insufficient. Do not install the identity review fixture automatically.
3. Independently reconcile custody, customer balances, all obligations, encumbrances and accessible liquid reserves at an authenticated common cutoff; investigate discrepancies without automatic repair.
4. Verify encrypted production backup and isolated restoration, operational monitoring, incident response, authorization and applicable compliance. Review economic backing for any return commitments.
5. Separate final owner authorization after all gates pass. Until then live deposit, withdrawal, custody, settlement, investment funding and other financial writes remain disabled.

No production database or wallet data was accessed by this checkpoint; it records code/test evidence only. No new paid service was purchased.
