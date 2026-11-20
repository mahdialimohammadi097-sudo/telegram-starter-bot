# PROFINO financial ledger release gates — 2026-11-19

Status: **review only; NOT authorized for live money movement**.

## Scope and evidence
- Audited `src/ledger-posting.js`, `src/transaction-safety.js`, `test-support/simulated-withdrawal.js`, and the beginning of `src/ledger-posting.postgres.test.js` on `feature/integrated-postgres-matrix` (head `da190ba63dda0a7e0f3d67befbc4eb7217b1225b`).
- Reviewed PR metadata and changed-file lists for #35, #42, #49, #50 and #51. All remain open drafts in the audit snapshot. PR #54 (integrated release) is open and unmerged.
- Reviewed the production `main` `src/commands.js`: Deposit and Withdraw are explicitly disabled; Investment Plans, My Investments and Transaction History return placeholder text.
- Prior FadeHost MCP read-only GitHub Actions run 44547249430 concluded success. This is connectivity evidence only, not a financial integration test.
- Added a new PostgreSQL regression test for concurrent opposite-direction AVAILABLE transfers on this audit branch. **Subsequently executed and passed in CI**, as recorded below. Prior PR descriptions reporting passing suites remain historical claims, not fresh results.

## Observed ledger safeguards in candidate
1. `normalizeEntries` uses exact 8-decimal USDT units and checks balanced debit/credit entries.
2. `postJournalInTransaction` serializes the same idempotency key via PostgreSQL transaction advisory locks and compares prior journal metadata and entries before replay.
3. Account rows are locked with `FOR UPDATE` in deterministic numeric order; AVAILABLE balances are checked against the aggregate net movement.
4. `withLedgerTransaction` owns BEGIN/COMMIT/ROLLBACK and destroys a connection if ROLLBACK itself fails.
5. Simulation-only withdrawal reservations transfer value from AVAILABLE to WITHDRAWAL_HOLD inside a transaction; they do not send tokens.

These are code-level observations, **not** proof of production safety or economic backing.

## Additional hardening on this branch
- Exact USDT parsing now rejects unsafe integer JavaScript numbers; decimal strings remain exact.
- Ledger account ID normalization now rejects non-safe numeric IDs rather than silently rounding them; decimal-string identifiers remain supported.
- Ledger account identifiers are additionally restricted to the PostgreSQL signed BIGINT range and bounded input length; regression tests cover the upper boundary and out-of-range values.
- Added focused unit regression tests for both precision hazards.
- Added PostgreSQL regression coverage for opposite-direction concurrent transfers.
- **The tests added through commit `8cdc0f0` were subsequently verified in CI run `44555009608` (120/120 per matrix job, zero skipped).**

## Required gates before merge and production release
- [ ] Re-run Node.js test matrix and PostgreSQL 17 integration suite on the **exact** intended merge commit; report pass/fail/skip counts, including zero unexplained skips. **Progress:** branch head `5854367` passed CI run `44555299682` on all three Node.js versions; this is not yet an intended merge commit.
- [ ] Verify full ledger contract and trigger definitions against target database with read-only catalog queries; do not infer production constraints from test fixtures.
- [ ] Test concurrent distinct-key debits, identical-key replay, conflicting-key replay, commit failure, rollback failure, and ledger immutability against an isolated PostgreSQL 17 instance.
- [ ] Confirm role and row-level authorization boundaries for every customer and administrator path; add negative tests for cross-user access and suspended users.
- [ ] Validate end-to-end simulated deposit, withdrawal hold, cancellation, settlement and reconciliation without external transfers; investigate any discrepancies.
- [ ] Review all PR dependency chains and final cumulative diff; do not merge draft financial branches independently or bypass review.
- [ ] Establish a tested, encrypted production backup and restore process, including recovery ownership, RPO/RTO targets and a restore drill covering financial tables. A local drill of operational tables is insufficient.
- [ ] Complete threat modeling, secret handling, monitoring/alerts, operational runbooks, rate limits, and incident-response controls.
- [ ] Independently validate funds/liquidity supporting any promised returns and applicable legal/compliance requirements.
- [ ] Obtain explicit owner sign-off **after** evidence-based release review; only then separately authorize enabling live deposits, withdrawals, custody or settlement.

## Release decision
**NO-GO for live customer funds.** The financial work is still branch-isolated, customer payment paths are disabled on main, and the above release gates remain open.

## Suggested next engineering action
In a new isolated implementation branch based on the audited integration candidate, add or extend PostgreSQL tests for concurrent distinct-key withdrawals and rollback failure, then run the full CI matrix. Do not modify production data or deployment settings.

## Verified CI evidence — 2026-11-19
- Workflow run: https://github.com/mahdialimohammadi097-sudo/telegram-starter-bot/actions/runs/44554139368
- Commit: `c71f12167a29dd06ba22080db864ff24f9cbc435` (the run predates any later documentation-only changes).
- Node.js 22, 24 and 26 with PostgreSQL 17: 119 tests passed, 0 failed, 0 skipped **per matrix job**.
- Focused PostgreSQL test command on Node.js 22: 33 passed, 0 failed, 0 skipped (overlaps the main suite).
- Node.js 22 production-dependency audit and synthetic wallet backup/restore replay both succeeded.
- These results establish CI success for the audited commit, **not** production readiness, a verified production restore, or authorization for live customer funds.

## Verified reviewer revocation regression — 2026-11-19
- Commit `8cdc0f02d9eb5eb1361f517fed4515a4ab3d76d3`: added PostgreSQL test ensuring revoked simulation reviewers cannot replay a completed release through either direct service or Telegram review adapter.
- GitHub Actions run: https://github.com/mahdialimohammadi097-sudo/telegram-starter-bot/actions/runs/44555009608
- Node.js 22, 24 and 26 / PostgreSQL 17: 120 tests passed per matrix job; 0 failed and 0 skipped.
- Focused PostgreSQL suite on Node.js 22: 34 passed, 0 failed, 0 skipped; this repeats a subset of the main suite.
- This proves simulated-review behavior on the tested commit, not the authorization or readiness of live withdrawals.

## Latest documentation-only commit validation
- Branch commit `58543675136847bec11cac68bff90708f501fcf3` passed GitHub Actions run https://github.com/mahdialimohammadi097-sudo/telegram-starter-bot/actions/runs/44555299682 on Node.js 22, 24 and 26 with PostgreSQL 17.
- No production DB schema, live funds, or deployment settings were modified by this audit PR.

## Suspended simulation reviewer authorization — verified 2026-11-19
- Direct simulation reviewer release now requires both an active reviewer membership and an active `users.status`, with PostgreSQL shared row locks on both authorization rows.
- Regression test: a blocked user retaining active simulation reviewer membership cannot release a reserved simulated withdrawal; request state and balance remain unchanged.
- Commit `187bcb47c9dcac266bb9efb6c827bdedaca54fef`; CI https://github.com/mahdialimohammadi097-sudo/telegram-starter-bot/actions/runs/44555821157 concluded success.
- Node.js 22/24/26 + PostgreSQL 17: 121 passed, 0 failed, 0 skipped **per job**. Focused PostgreSQL run on Node.js 22: 35 passed, 0 failed, 0 skipped (overlapping tests).
- This authorization fix is for the **simulation-only** reviewer service, not a live withdrawal approval system.

## Consolidated audit checkpoint — commit afc08e6 (2026-11-19)

Latest independently checked workflow: https://github.com/mahdialimohammadi097-sudo/telegram-starter-bot/actions/runs/44562814143

- Commit: `afc08e6e7827c04a18e10062ef5e90aad5789f1e`.
- GitHub Actions conclusion: success; Node.js 22, 24, and 26 with PostgreSQL 17 each completed **132 passed, 0 failed, 0 skipped** in the primary suite.
- Focused PostgreSQL suite on Node.js 22: **46 passed, 0 failed, 0 skipped**. These 46 tests overlap the primary suite and are not additional independent tests.
- Added simulation-only regression coverage for active/suspended customers, blocked-customer cancellation and reviewer releases, concurrent reviewer releases, revoked reviewer read/release permissions, two independent authorization gates, and a revocation transaction that locks the reviewer row while release authorization starts.
- PostgreSQL integration tests use **ephemeral isolated schemas and synthetic funds**; this does not verify the deployed FadeHost database, production schema privileges, secrets, backups, reserve liquidity, or legal/compliance readiness.
- CI success is evidence for this branch head only, not for the eventual integration merge commit. PR #57 remains **open, draft, unmerged** and targets `feature/integrated-postgres-matrix`, not `main`.
- **Decision: NO-GO** for real deposits, withdrawals, custody, and settlement. No production deployment or real fund transfer is authorized.

### Remaining critical release blockers

1. Read-only inspection of the actual target PostgreSQL 17 catalog, grants, constraints, triggers, RLS and schema migrations; reconcile with isolated test fixtures.
2. Complete PR dependency and final integration diff review, then re-run the full test matrix on the exact merge candidate.
3. Validate production-grade encrypted backups, restore ownership, recovery objectives and a non-destructive restore drill.
4. Complete adversarial authorization, cross-user, concurrency, rate-limit, incident response, secrets and operational monitoring review.
5. Verify economic backing/liquidity and compliance requirements for advertised guaranteed returns, and obtain explicit owner release authorization.

The historical evidence sections above describe earlier branch states and must not be interpreted as the latest CI result.

## Fresh pull-request dependency audit — 2026-11-19

Read directly from GitHub PR metadata (all **open, unmerged** at inspection time):

| PR | Base | Head | Draft |
| --- | --- | --- | --- |
| #31 | main | feature/phase2-financial-foundation-clean | yes |
| #32 | main | feature/referral-invite-link-foundation | yes |
| #35 | main | feature/ledger-posting-foundation | yes |
| #36 | feature/ledger-posting-foundation | feature/ledger-posting-postgres17-tests | yes |
| #42 | feature/ledger-posting-postgres17-tests | feature/ledger-posting-integrity-tests | yes |
| #45 | feature/phase2-financial-foundation-clean | feature/security-error-logs-after-financial-audit | yes |
| #46 | feature/security-error-logs-after-financial-audit | feature/security-startup-diagnostics-after-audit | yes |
| #49 | feature/ledger-posting-integrity-tests | feature/ledger-production-contract | yes |
| #50 | feature/ledger-production-contract | feature/simulated-deposit-wallet | yes |
| #51 | feature/simulated-deposit-wallet | feature/integrated-postgres-matrix | yes |
| #54 | main | feature/post-edit-session-guard | no |
| #57 | feature/integrated-postgres-matrix | audit/ledger-release-gates-20261119 | yes |

**Integration implications:** #35 -> #36 -> #42 -> #49 -> #50 -> #51 -> #57 is a stacked chain; #31 -> #45 -> #46 is a separate stack; #32 and #54 target main. Do not merge child PRs independently, assume the stacks are compatible, or move live financial code into main without a complete cumulative-diff/security review and exact-candidate CI.

Latest verified audit-branch CI run before this documentation change: https://github.com/mahdialimohammadi097-sudo/telegram-starter-bot/actions/runs/44563034962 (success). This PR metadata check is **not** a code-level review of all changed files or a verified deploy.

## Cross-branch overlap inspection — 2026-11-19

Compared GitHub's changed-filename lists for PR #54 (base `main`) and PR #57 (base `feature/integrated-postgres-matrix`). **Seven overlapping changed paths**:
`.github/workflows/validate.yml`, `src/ledger-posting.js`, `src/ledger-posting.postgres.test.js`, `src/ledger-posting.test.js`, `src/ledger-safety.test.js`, `test-support/simulated-investment.js`, `test-support/simulated-withdrawal.js`.

Fetched the actual file contents at both heads for three paths and verified they differ:
- `src/ledger-posting.js`: PR #54 head blob `5e3f780`, audit head blob `0520e7b`.
- `test-support/simulated-withdrawal.js`: PR #54 head blob `fc20507`, audit head blob `4f7e213`. **Substantial implementation divergence**: 10,920 versus 6,540 characters. This requires a semantic reconciliation, not a blind overwrite or automatic assumption of compatibility.
- `src/ledger-safety.js`: PR #54 head blob `d6eda0d`, audit head blob `5dbd05e`. This path is not listed as a changed file in PR #57 relative to its base? The audit branch has its own precision hardening and the branch heads still differ.

The seven-path overlap is a **potential integration risk**, not proof of Git merge conflicts. Comparing file lengths/hashes does not establish which implementation is correct. Do not cherry-pick, force-merge, or replace either branch's withdrawal service without inspecting the complete diff, call sites, migrations, and tests.

Next: inspect semantic differences in the withdrawal service and ledger APIs, design an isolated integration candidate, run both branches' tests on the exact combined tree, and review authorization and balance invariants. No live funds.

## Semantic comparison of withdrawal services and schemas — 2026-11-19

Read the complete `test-support/simulated-withdrawal.js` and `test-support/withdrawal-schema.js` from `feature/post-edit-session-guard` (#54 head) and `audit/ledger-release-gates-20261119` (#57 head).

**Shared behavior:** both reserve USDT in a WITHDRAWAL_HOLD journal, support customer cancellation and authorized reviewer release, serialize reservation via a user row lock, and use ledger idempotency keys.

**Security delta in audit #57:** `reserveWithdrawal` requires `users.status='active'` before even returning an existing request key; reviewer release joins active reviewer membership with active user status and locks both authorization rows `FOR SHARE OF r,u`. The #54 service only checks user existence on reservation and only active reviewer membership on direct reviewer release. Both branches' Telegram reviewer list/inspect paths already require active user and membership.

**Feature delta in #54:** optional EVM-style destination validation and idempotent destination comparison; synthetic testnet claim/submission with payload hash, retry/recovery transport, and testnet receipt verification/payout journal into a clearing account. These are testnet/synthetic facilities, **not permission for real token transfers**. The #57 service does not implement these APIs.

**Schema delta:** #54 permits `reserved`, `cancelled`, `pending_receipt`, `paid`, with `submitted_hash`, `simulation_payload`, `destination`, `payout_event`, `payout_id`, `clearing_id`, and associated checks/references. #57 permits only `reserved` and `cancelled` and lacks those fields. This is a real **schema and lifecycle incompatibility** if code is blindly transplanted across branches.

**Safe integration requirements:**
1. Decide explicitly whether the testnet submission/recovery/receipt feature belongs in the release candidate; keep it isolated and disabled for production funds.
2. If retained, adopt the complete extended schema, corresponding reconciliation rules and negative tests for `pending_receipt`/`paid` (especially cancellation, replay, and out-of-order receipt), not just extra service functions.
3. Port active-customer and active-reviewer authorization checks from #57 to the extended service, preserving row-lock ordering and idempotency checks.
4. Ensure wallet and Telegram command callers use compatible signatures and destination semantics.
5. Run complete integration suites of both branches on an isolated combined tree; inspect SQL migrations and exact intended merge commit. No direct production changes.

**Decision:** semantic conflict confirmed; integration not yet performed. Preserve both implementations until tests and review establish a safe combined contract.
