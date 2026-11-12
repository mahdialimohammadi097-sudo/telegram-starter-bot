# PROFINO implementation status

## Review candidate, 2026-11-12

PR #51 targets `feature/simulated-deposit-wallet`. The customer menu and ledger tests below run against disposable PostgreSQL 17 with offline Telegram updates. The [validation run for revision e3e67d1](https://github.com/mahdialimohammadi097-sudo/telegram-starter-bot/actions/runs/43267089520) passed all 104 tests on Node.js 22, 24 and 26.

| Review area | Demonstrated on the candidate | Scope still open |
| --- | --- | --- |
| Registration and wallet | Private registration creates three USDT ledger accounts. Repeated registration repairs missing accounts. The wallet reads posted entries and pages older history by owner. | Verify the release candidate against the target registration schema and triggers. |
| Plans and settlement | The menu previews 15 plan/amount combinations. Test code opens a SMART investment for 25 test USDT, advances maturity and settles 27.36. The customer sees 2.36 in net profit for the UTC settlement date. | Opening and settlement in this journey are driven by simulation helpers. |
| Transfers | The transfer screens display posted credits, reservations and releases. Tests cover concurrent retries, interrupted commits and independent reconciliation. | A simulated release returns held funds to the available wallet. External payout delivery and authorization remain unverified. |
| Private administration | Tests exercise owner-only access, stored English/Persian preference, user search and post-history navigation. | Complete the remaining localization review and review any future financial approval workflow separately. |

For the end-to-end example, review the test named `one private Telegram wallet tracks a synthetic deposit, SMART settlement, withdrawal hold and release` in `src/ledger-posting.postgres.test.js`. Compare the customer screens with the posted ledger journals. The candidate remains on its review branch pending owner review and a separate publication decision.

## Historical central review, 2026-11-11

Production baseline: `main` at `aeefcc9`. The public readiness endpoint returned ready. The open work below is on review branches. Customer text is English and the private admin panel supports English and Persian. Scope excludes exchange integration and automated trading.

Coverage in this table counts explicitly named checkpoints, with equal weight **within each row**. These ratios describe engineering evidence, not estimates of time, effort, or permission to release. A checkpoint can be covered by a tested draft. The workstreams have different denominators and overlap, so their scores must not be averaged.

| Workstream | Covered checkpoints | Remaining checkpoints | Coverage |
| --- | --- | --- | --- |
| Central coordination | PR inventory, dependency map, reproducible conflict checks, combined financial candidate with the recorded CI and documentation conflicts resolved | Owner review of this candidate | 4/4 recorded coordination checkpoints |
| Infrastructure and database | Live readiness, ledger schema review, synthetic five-table restore | Validated recovery from a production-equivalent backup | 3/4 |
| Telegram customer experience | Registration and private-chat flow, wallet reader, tested referral-link creation | Referral attribution, end-to-end Telegram acceptance of all customer screens | 3/5 |
| Private administration and security | Owner access controls, bilingual core operations, diagnostic redaction in drafts | Full localization audit, authorized financial review with an audit trail | 3/5 |
| Wallet and ledger | Exact USDT, balanced posting, concurrent replay protection, insufficient-balance protection | Reversal flow, independent reconciliation | 4/6 |
| Deposits and withdrawals | Synthetic deposit approval through the wallet reader, duplicate transfer claims | Complete deposit verification, withdrawal authorization, payout reconciliation | 2/5 |
| Investment and settlement | None of the listed executable acceptance cases has been established | Versioned plan opening, maturity, fee calculation, manual reinvestment, settlement accounting | 0/5 |
| QA and release | Baseline tests, PostgreSQL integration, channel permission check, restore drill, combined financial candidate | Owner-approved release | 5/6 |

### Integration candidate #51

The candidate combines #34, #46 and #50, including their financial and ledger ancestors. It also incorporates the recorded audit evidence from #37. The [three CI jobs](https://github.com/mahdialimohammadi097-sudo/telegram-starter-bot/actions/runs/43093073210) each passed 82 tests with PostgreSQL 17 and zero skips. The recorded receipt represents a public test token. Synthetic user assignments and isolated balances are used throughout. The test suite includes rollback, cross-request duplication, incorrect token or recipient, and independent journal reconciliation.

### Review queue at the previous inventory

| Base or sequence | Open PRs | Work |
| --- | --- | --- |
| main, then stacked | #31 → #45 → #46 | Financial diagnostics, command redaction, runtime redaction |
| main, then stacked | #35 → #36 → #42 → #49 → #50 | Posting, concurrency, integrity, audited trigger contract, simulated deposit |
| main | #32, #34, #37, #38 | Invite link, CI matrix, evidence, connection audit |
| main | #39, #43, #47, #48 | Startup report, configuration example, channel permissions, restore drill |

All 16 were open at review. Only #34 was marked ready for review. All heads had a successful Actions run. The original #48 check ran the general tests alone. The [dedicated restore run](https://github.com/mahdialimohammadi097-sudo/telegram-starter-bot/actions/runs/43088370789) now executes the actual drill offline against disposable PostgreSQL 17. It verifies five synthetic operational tables. The [#50 validation](https://github.com/mahdialimohammadi097-sudo/telegram-starter-bot/actions/runs/43070424753) covers two concurrent approvals of one simulated request, replay, rollback and the wallet read path. It does not verify a transfer on a network.

### Integration order

1. Review the candidate's workflow, audit documents and pinned source commits. Re-run the matrix when any contributing branch advances.
2. Exercise independent deposit-address assignment, token configuration, and continuity across restarts in a disposable environment.
3. Cover withdrawal authorization and reconciliation using synthetic requests before wiring any Telegram financial action.
4. Treat release, production writes and handling real funds as separate owner decisions. Funding evidence, security and legal review remain prerequisites for real financial operation.

## Earlier baseline audit

The following observations describe the earlier audit of main. Subsequent draft evidence, including the extracted ledger trigger definitions and numeric-scale tests in #49, is tracked above.

**Audit date:** 2026-11-11
**Audited source revision:** `aeefcc9f2b94e54f164b9e3af89ff7e10a10b89f` (main at 2026-11-11)
**Scope:** Static review of the repository source. Production runtime and `/start` were verified. Only read-only aggregate database inventory output was reviewed; no full production DDL/schema snapshot or trigger-function definitions were captured. No live financial transaction was performed.

## Progress snapshot

Percentages below describe implementation completeness in the audited source. A 100% code-completion score does not replace live production smoke tests, provider verification, or operational sign-off.

| Area | Estimate | Evidence / limitation |
|---|---:|---|
| Bot runtime and Telegram connection | 100% (code) | Polling and webhook startup, transient dependency retries, strict readiness/liveness endpoints, Telegram receiver-aware health state, reconnect backoff, and graceful shutdown are implemented. Syntax and unit tests pass. FadeHost deployment logs, HTTP 200 health checks, and the owner's successful `/start` interaction are confirmed. Operational monitoring is not a substitute for full end-to-end financial testing. |
| PostgreSQL connectivity and diagnostics | 85% (connectivity/diagnostics code) | Production connection and read-only aggregate inventory were confirmed. One diagnostic reported 9/9 expected core tables, 24 total tables, 68 indexes and 16 user-defined triggers; an earlier manual listing counted 25 tables, so the inventory count itself needs reconciliation. This is not a schema audit: exact financial-table columns, types, constraints, indexes, trigger definitions and trigger-function bodies remain unverified. |
| User registration and access control | 70% | Registration, private-chat enforcement, account status checks and per-process rate limiting exist. New users are currently created as active; pending/manual approval is not part of registration. |
| Wallet balance display | 35% | Reads posted ledger entries for AVAILABLE, INVESTED and PROFIT; no complete financial transaction lifecycle is exposed. |
| Investment plans and active investments | 5% | User-facing sections are placeholders. |
| Deposits | 0% | Bot explicitly says automatic deposit verification is not enabled. |
| Withdrawals | 0% | Withdrawal service is explicitly disabled. |
| Profit calculation and posting | 5% | Profit records are referenced by diagnostics, but no verified accrual/distribution workflow was found in the reviewed user flows. |
| Referral program | 10% | Referral code is generated at registration and the customer menu now displays a validated Telegram invite link. Referral attribution, reporting, anti-self-referral controls, and any rewards remain unimplemented. |
| Admin operations | 75% | Owner-only dashboard, user lookup/status operations, audit logging, persisted language preference and bilingual publishing/history workflows exist; some diagnostic/error screens still need localization and production verification. |
| Scheduled channel publishing | 90% | Drafting, preview, approval, scheduling, history and interrupted-operation recovery exist; admin-facing preview, approval, scheduling and history messages now support English/Persian. Production end-to-end testing remains necessary. |
| Internal and external monitoring | 95% (code and workflow evidence) | Internal Telegram/database checks and an independent five-minute `/healthz` workflow exist. GitHub Actions run history confirms successful Telegram `sendMessage` steps on status transitions, a down check, a later successful recovery check, and a subsequent healthy `/healthz` check. Receipt on the owner's device and alert behavior during a future outage remain unverified. |
| Security and financial risk controls | 50% | Private-chat checks, rate limiting and admin guards exist; custody, withdrawal approval, reconciliation, AML/KYC and financial risk controls are not complete. |
| Admin language selector (English/Persian) | 70% | Persistent preference, language selector, dashboard, user operations, publishing previews, scheduler feedback, post history, and core admin diagnostic/error feedback are bilingual; a final sweep and production verification remain. |

**No single overall completion percentage is published.** A simple average would give equal weight to monitoring and custody/financial execution, which would materially misrepresent readiness.

## Confirmed runtime safeguards
- `/healthz` returns HTTP 200 only when PostgreSQL, Telegram API, and the update receiver are ready; it returns HTTP 503 otherwise.
- `/livez` reports process liveness independently of dependency readiness.
- Startup binds the HTTP server before waiting on external dependencies, allowing the host to observe a starting-but-not-ready process.
- Transient PostgreSQL and Telegram API startup failures retry with capped exponential backoff; invalid Telegram credentials fail fast.
- Polling reconnects with capped backoff; webhook readiness verifies the registered webhook URL.
- SIGINT/SIGTERM stop the scheduler and health monitor, stop Telegram polling, close the HTTP server, and close the PostgreSQL pool.
- The external uptime workflow now judges availability from `/healthz` only, not from the always-live root page.

## Repository release governance

- The GitHub `main` branch currently reports `protected=false`. No branch-protection or ruleset configuration was changed during this audit. Before production releases, require pull requests, passing required checks, and restricted direct pushes/force pushes. This is a repository setting that must be enabled by an authorized repository administrator.

## Confirmed safeguards
- The customer-facing bot strings inspected in `src/commands.js` are English.
- Wallet balances are read from ledger transactions with `posted` status only.
- Wallet USDT formatting now preserves decimal precision without converting database numeric values to JavaScript floating-point numbers.
- Deposit and withdrawal screens warn that the services are not enabled.
- Admin operations are restricted to the configured owner in a private chat.
- Scheduled posts require an explicit admin approval step before publication.
- Health diagnostics are read-only.

## Blocking work before handling real customer funds
1. Obtain and reconcile a read-only production schema snapshot for all financial tables; inspect exact columns, numeric precision, foreign keys, unique constraints, indexes, deferred constraints, trigger definitions and trigger-function bodies. Aggregate table/index/trigger counts do not satisfy this gate.
2. Design and test idempotent deposit detection and confirmation; never display a deposit address until network, token contract, confirmations and ownership controls are verified.
3. Implement withdrawal requests with multi-step authorization, limits, sanctions/AML checks where legally required, and reconciliation.
4. Implement immutable double-entry ledger posting with atomic transactions, unique idempotency keys, balance invariants and reversal procedures.
5. Implement investment plans, profit accounting and referral rewards only after funding sources, liquidity, risk limits and legal review are documented.
6. Finish the remaining admin diagnostic localization and production verification.
7. Add integration tests with a disposable database and testnet-only payment flows; do not test with customer funds.

## Next safe implementation sequence
- **Completed runtime foundation:** startup/readiness/reconnect/shutdown implementation and automated tests; the Phase 1 audit records FadeHost deployment, `/healthz` HTTP 200, and owner-confirmed `/start`. Ongoing alert delivery still requires separate verification.
- **Completed admin localization foundation:** persisted language preference and the principal admin workflows.
- **Phase 1:** PR #29's read-only diagnostic and exact eight-decimal helper hardening are merged. Collecting and reviewing the complete live `/dbschema` output remains pending. PR #31 extends diagnostic metadata and tests it against disposable PostgreSQL 17; PRs #35/#36 provide an isolated ledger-posting foundation and integration tests, still draft and not production-enabled.
- **Phase 3:** Referral attribution without monetary rewards.
- **Phase 4:** Testnet deposit watcher and reconciliation, behind a disabled-by-default feature flag.
- **Phase 5:** Withdrawal workflow and risk controls, also disabled until independently reviewed.

## Files reviewed
- `src/admin-language.js`
- `src/ledger-safety.js`
- `src/ledger-safety.test.js`
- `src/post-history.js`
- `index.js`
- `src/commands.js`
- `src/database.js`
- `src/database-diagnostics.js`
- `src/admin-ops.js`
- `src/scheduler.js`
- `src/post-management.js`
- `src/health-http.js`
- `src/health-http.test.js`
- `src/runtime-health.js`
- `src/runtime-health.test.js`
- `src/health-monitor.js`
- `.github/workflows/validate.yml`
- `.github/workflows/external-uptime.yml`
- `package.json`


## 2026-11-11 follow-up evidence — branch-only work

The following changes are present on open draft pull requests and are **not part of main or the deployed service**:

- **PR #35 — isolated ledger-posting foundation:** adds a transaction-scoped posting service with exact eight-decimal USDT arithmetic, balanced-entry validation, account row locks, idempotency comparison, rollback handling, and a non-negative projected-balance check for `AVAILABLE` accounts. The status transition requires exactly one row to move from `pending` to `posted`; if rollback itself fails, the client is discarded rather than returned to the pool. Latest CI run #42975311041 passed 43/43 unit tests, 0 failed, 0 skipped.
- **PR #36 — PostgreSQL 17 integration tests:** uses a uniquely named temporary schema and tests concurrent identical idempotency keys, competing `AVAILABLE` debits, and full rollback when an injected trigger rejects an entry. The branch includes the current PR #35 head using a non-force-forward merge commit and is 7 commits ahead / 0 behind its base. Latest run #42975463597 passed on head `6dcf38e85b553176e5a8a27da722953c57dacbe7` using PostgreSQL 17.11: 46 tests passed, 0 failed, 0 skipped. Three DB-backed cases cover concurrent identical idempotency, competing AVAILABLE debits, and whole-journal rollback after an injected trigger failure. The schema remains minimal and is not production-schema verification.
- **PR #42 — ledger integrity trigger tests:** chained on PR #36; adds tests for database rejection of unbalanced posting and appending entries to a posted journal. GitHub Actions run #42981361057 passed 51/51 tests on PostgreSQL 17.11, 0 failed. The expanded suite also covers deferred constraint failure at COMMIT, full rollback, posted-entry UPDATE/DELETE immutability, concurrent identical-key replay and concurrent mismatched-payload reuse. All added database triggers are synthetic test fixtures; this is not verification of FadeHost production DDL or trigger/function behavior. PR #41 was closed as superseded; no changes were merged.
- **PR #37 — ledger audit evidence:** documentation-only update; CI run #244 passed.
- **PR #38 — database connection security review:** documentation-only review; records that `src/database.js` sets `ssl: false`. Whether this is exploitable depends on FadeHost's actual network topology and TLS support, neither of which has been verified. CI run #249 passed.
- **PR #39 — startup diagnostic sanitization:** restricts the startup report to a validated five-character SQLSTATE or the fixed `UNAVAILABLE` label, preventing arbitrary PostgreSQL driver error text from leaking into the admin report. CI run #251 passed.
- **PR #45 — command and scheduler diagnostic sanitization:** chained on PR #31; sanitizes command handlers, post management/history, and scheduler while preserving PR #31's command/helper changes. CI run #42984567942 passed 40/40 tests, 0 failed, 0 skipped.
- **PR #46 — startup/runtime diagnostic sanitization:** chained on PR #45; sanitizes entry-point startup, update-handler, retry, schema-inspection, and shutdown exception logs. CI run #42984646202 passed 40/40 tests, 0 failed, 0 skipped.
- PRs #40 and #44 were closed as superseded by the corrected dependency chain; neither was merged. PRs #45 and #46 remain draft and unmerged.
- **PR #31 — financial product plan and schema diagnostics:** branch is aligned with current main (0 behind). Read-only diagnostics include numeric precision/scale, identity/generated-column metadata, constraint deferrability/validation and trigger enabled/deferrable state. A disposable PostgreSQL 17.11 integration test verifies these query results. The admin user-status transaction now checks exactly one updated row and discards its pooled client if rollback fails; admin diagnostics/logging now expose only a validated five-character SQLSTATE or `UNAVAILABLE`, never raw driver messages. Latest CI run #42976314221 passed 40/40 tests, 0 failed, 0 skipped. This does not verify the production database.
- **PR #32 — referral invite-link display:** branch is aligned with current main (0 behind); referral codes are normalized to lowercase before link construction. Latest run #42975130905 passed 37/37 tests, 0 failed, 0 skipped. Referral attribution and rewards remain disabled.
- **PR #34 — Node.js CI matrix:** the original Node 20 entry was removed because Node 20 reached EOL on 2026-04-30. The matrix now targets maintained LTS lines 22, 24 and 26; run #42976542716 passed all three validation jobs for head `0623d461b4701629605d38047b87c3818ed7f9c1`.

These branch tests use a minimal disposable schema. They do not reproduce the full production schema, deferred constraints, trigger/function bodies, or FadeHost runtime. Therefore, they are useful engineering evidence but do not satisfy the production-schema acceptance gate and do not authorize enabling any financial workflow.

**Production boundary unchanged:** no PR above has been merged or deployed; no production database, schema, secrets, customer balance, deposit, withdrawal, or financial transaction has been changed.
