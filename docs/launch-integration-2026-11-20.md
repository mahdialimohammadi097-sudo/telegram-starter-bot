# Launch candidate integration — 20 November 2026

Financial activation remains NO-GO. This branch does not enable customer deposits,
chain signing, real withdrawals, or settlement, and has not been deployed.

## Dependency reconciliation

Starting integration head: 8fdb2913585c9cb6fb368a091f9607686f98c2fe.
It was 258 commits ahead of main and one behind. This candidate preserves ancestry
of main 51a462784169fd7d6de4a7bfc0cfa5e9b56ba0af and PR #76
f7fa7948ae38bdf1149771fc31fef926abf17072, plus the PR #58/#59 head
cafd32489b5f5dbe2df2a4dd2441581ab150ab7f. Do not individually re-merge these stacks.
The #31/#32/#35/#36/#42/#45/#46/#49/#50/#51 foundation chains are ancestors.
The #53/#54 publishing work is included through #59. Older #52 baseline is an
ancestor. #57's safety logic is in #59; its older withdrawal schema must not
replace the four-state schema. #55's idle pool error behavior is implemented
with sanitized diagnostics here rather than taking its raw-message logging.
#56 is a separate connectivity experiment, not runtime access or a release dependency.

Merge resolutions: use #59's user-scoped simulation keys and private-chat guards;
retain the integration TLS helper, support both historical setting names, and
reject contradictory settings and URL SSL overrides. Preserve private-network
default until provider TLS requirements are verified. Keep both branches' tests.

## New deposit coordinator

`src/confirmed-deposit-posting.js` snapshots receipt evidence, requires exact
base-unit/ledger-amount agreement and canonical event identity, and performs
ownership resolution, account validation and balanced posting in one transaction.
The event's stable journal metadata binds owner, address and contract. Replays
with a different amount or owner fail. PostgreSQL tests cover concurrent replay,
failed credit rollback, inactive/ambiguous owners and assignment-lock retention.

This is a coordinator, not a completed production deposit pipeline. Its required
ownership adapter is not implemented against guessed production tables. A reviewed
adapter must lock the address namespace (including possible new rows), reject
reassigned/historical ambiguity, verify active user/wallet status, and return all
assignments on the same transaction client. Evidence must come only from the trusted
receipt reader. There is no Telegram writer or polling entry point for this function.

## Validation and remaining gates

Initial deposit-only candidate f5e7b39: CI run 44741130530, Node 22 log reports
166 passed, 0 failed, 0 skipped; focused PostgreSQL suite 38 passed. This evidence
is NOT validation of later integration commits. Consult PR #79's current checks.

Remaining launch blockers:
- Fresh FadeHost catalog inspection and reviewed production ownership adapter,
  immutable address allocation policy, custody/signing and secure treasury setup.
- Chain-to-ledger reconciliation, persisted observation lifecycle and reorg recovery.
- Production-compatible withdrawal/investment adapters and migration rehearsal.
  Existing four-state withdrawals and investment lifecycle are synthetic tests.
- Same-bot owner rehearsal with an isolated marked database; live Telegram acceptance.
- Production backup restore/rollback and network/TLS evidence; security/accounting
  review, owner-confirmed applicable legal prerequisites and explicit activation approval.

No FadeHost connector or runtime DB credential was exposed in this session.
Browser login navigation was rejected by automatic approval review; no production
catalog query ran. `scripts/deposit-wallet-catalog.sql` is a bounded READ ONLY
catalog inspection script; it returns metadata, not customer rows. Access must be
provided through an authenticated hosting connection or the read-only script's
results, without publishing credentials or making the private database public.

## Read-only confirmed-deposit reconciliation

`src/confirmed-deposit-reconciliation.js` compares a batch of 1–500 independently
verified events and historical ownership expectations against the journal, entries
and account owners in one PostgreSQL MVCC snapshot. It flags missing/duplicate
journals, unposted states, wrong event identity, mismatched attribution and wrong
amount/currency/account/entry count. All arithmetic comparisons use exact units.
No write or automatic repair is performed. Results explicitly cover supplied
events only: this is not a full chain scan or orphan-journal audit, and events
omitted by the source (or journals with both identifying fields corrupted) still
require an independent persisted scanner/cursor and full reconciliation process.
Production ownership and evidence adapters remain blocked on the catalog review.
