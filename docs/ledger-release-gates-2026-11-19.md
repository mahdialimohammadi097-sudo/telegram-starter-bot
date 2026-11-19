# PROFINO financial ledger release gates — 2026-11-19

Status: **review only; NOT authorized for live money movement**.

## Scope and evidence
- Audited `src/ledger-posting.js`, `src/transaction-safety.js`, `test-support/simulated-withdrawal.js`, and the beginning of `src/ledger-posting.postgres.test.js` on `feature/integrated-postgres-matrix` (head `da190ba63dda0a7e0f3d67befbc4eb7217b1225b`).
- Reviewed PR metadata and changed-file lists for #35, #42, #49, #50 and #51. All remain open drafts in the audit snapshot. PR #54 (integrated release) is open and unmerged.
- Reviewed the production `main` `src/commands.js`: Deposit and Withdraw are explicitly disabled; Investment Plans, My Investments and Transaction History return placeholder text.
- Prior FadeHost MCP read-only GitHub Actions run 44547249430 concluded success. This is connectivity evidence only, not a financial integration test.
- Added a new PostgreSQL regression test for concurrent opposite-direction AVAILABLE transfers on this audit branch. **It has not been executed yet.** Prior PR descriptions reporting passing suites are historical claims, not fresh results.

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
- **All newly added tests remain unverified until an actual CI run or local test execution is recorded.**

## Required gates before merge and production release
- [ ] Re-run Node.js test matrix and PostgreSQL 17 integration suite on the **exact** intended merge commit; report pass/fail/skip counts, including zero unexplained skips.
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
