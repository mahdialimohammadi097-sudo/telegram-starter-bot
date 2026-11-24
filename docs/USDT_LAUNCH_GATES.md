# PROFINO — free-tier launch gate (NOT authorization to receive funds)

This document describes the current review-only BSC USDT deposit preparation for the **existing** Telegram bot. It does not enable deposits, withdrawals, settlement, wallet custody or investment payouts.

## Verified from GitHub

- PR #119 is the prerequisite offline ownership/evidence branch and remains draft.
- PR #120 is stacked on #119 and remains draft; CI checks test isolated code, not the live bot or FadeHost PostgreSQL database.
- No merge to `main`, production migration, payment request or financial activation is authorized by this checklist.

## Free checks available now

1. Run GitHub Actions JavaScript validation and the schema-audit script's unit tests. A green result **does not** validate production data.
2. Independently review BSC chain ID 56, approved USDT token contract/decimals, RPC trust assumptions, canonical block consistency and confirmation policy.
3. Review historical wallet assignment ownership and its provenance; reject ambiguous, overlapping or retroactively changed ownership intervals.
4. Review double-entry ledger proposal, exact 8-decimal USDT conversion, account identities, event identity and idempotency preflight. **A read-only preflight is not a race-safe writer.**
5. Review authentication, secret handling, least-privilege database access, logging, and error paths for the existing Telegram bot.

## Production gates still required before any real 10 USDT owner pilot

- [ ] Read-only inspection of **actual** FadeHost PostgreSQL schema and data, including required tables, types, non-null/unique event keys and ownership intervals. `node scripts/fadehost-schema-audit.js` is available only after its code is safely deployed; do not assume it is already installed on production.
- [ ] Verify the production schema matches the actual ledger posting implementation and account-type semantics. Do not treat `ready:true` from the limited audit as a financial go-live approval.
- [ ] Implement and independently test atomic, concurrency-safe claim-and-post with database-enforced idempotency, balanced entries, no negative available balances, rollback, replay/reorg handling and reconciliation.
- [ ] Verify trusted chain RPC providers, approved BSC USDT contract, finality policy, deposit address control and historical attribution against independent evidence.
- [ ] Complete security/accounting review, production backup-and-restore rehearsal and controlled rollback plan.
- [ ] Obtain **separate explicit owner authorization** after all checks pass, before enabling any real receipt, wallet funding, withdrawal or settlement.

## No-cost-first policy

Use existing GitHub Actions and local/offline tests. Do not require a paid FadeHost terminal, subscription or new Telegram bot. Defer checks that require unavailable production access; never mark them passed by inference. Keep all real financial operations disabled until every production gate is satisfied.

## Ledger code inspection — 2026-11-23

- Existing `main:src/ledger-safety.js` contains exact eight-decimal parsing (`toUsdtUnitsExact`), per-currency double-entry balance assertions and an available-balance overdraft guard. Their unit tests are in `main:src/ledger-safety.test.js`.
- These are **pure validation functions**, not evidence of a transactionally safe PostgreSQL posting service. The BSC deposit branch currently builds an **offline journal proposal** in `src/deposit-ledger-journal-draft.js` and only performs a read-only idempotency inspection in `src/deposit-idempotency-db-inspection.js`.
- Therefore: **do not mark atomic posting, durable unique event claims, row-level serialization, balance updates or reconciliation as implemented** on the strength of those helpers or green CI. A production-compatible writer and independent database contract tests remain blocking.

## Verified CI and review status — 2026-11-24

- GitHub Actions on commit `a3df2256a06a361d45ced313589c789024d9a11f`: **Validate JavaScript**, **FadeHost schema audit safety tests**, and **Disposable PostgreSQL ledger atomicity test** all completed successfully.
- The PostgreSQL workflow uses a disposable PostgreSQL 17 service and tests uniqueness, concurrent claims, rollback after invalid journal posting, and retry after rollback. Its fixture tables are **not** the production ledger schema and its test code is **not** a production posting implementation.
- GitHub review queries for PR #119 and PR #120 returned **zero submitted reviews**. Neither PR is approved for merging; #120 depends on #119.
- Keep both PRs unmerged pending independent financial/security review, production-schema evidence, and an actual atomic posting implementation.

## Atomic transaction contract evidence — 2026-11-24

- Commit `18ab6ced768edac3bc31d917b6828d718df9ba06`: all three CI workflows passed.
- The isolated transaction contract in `src/deposit-atomic-posting-contract.js` was exercised against disposable PostgreSQL tables: second-leg constraint failure rolls back both the event claim and first leg; retry succeeds and replay fails with a uniqueness violation.
- This establishes fixture behavior only. The contract has no production adapter, runtime wiring, or verified production schema mapping. Commit outcome ambiguity, production reconciliation and independent review remain unresolved.
- Next integration gate: obtain actual read-only schema evidence and map the production constraints before implementing a production-compatible adapter. Do not deploy or activate financial operations on the basis of fixture results.

## Operator-supplied production audit — 2026-11-24

The owner supplied FadeHost Schedules output for deployed main commit `e0d7509`. The read-only script exited 2 with ready:false. Missing checks: verified_deposit_evidence.event_key, block_hash, block_number, token_contract, deposit_address, amount_base_units, and unique:verified_deposit_evidence.event_key. Other checks in that limited deployed script did not report missing items. This does not establish table absence versus incompatible columns, nor validate financial integrity. The expanded draft-branch audit has not run in production. Before proposing DDL, inspect existing table metadata and constraints; preserve existing data and require independent migration review and disposable PostgreSQL tests. Temporary schedule removal requested; not independently confirmed. No production changes authorized.

## Deposit schema review checkpoint

Owner-provided targeted production metadata query returned [] for both deposit evidence and ownership history tables. This establishes no visible columns, not proof of absence under all roles. Review-only SQL at docs/review-only/deposit-schema-proposal.sql ends in ROLLBACK. CI at 938ff678d43ee199a6d65480ec7c20aafce3d147 passed all three workflows, including disposable PostgreSQL tests of overlap exclusion, adjacent intervals, evidence immutability and history mutation guards. PUBLIC privileges are revoked in the proposal; actual production role ownership, inherited grants, schema visibility, and dedicated non-owner runtime permissions remain unverified. No production migration or financial activation is authorized. Next: inspect production role privileges and table existence via read-only catalog queries, then independently review the migration and integration dependencies.
