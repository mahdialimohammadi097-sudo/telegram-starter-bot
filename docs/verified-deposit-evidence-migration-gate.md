# Verified deposit evidence: production migration gate

Live FadeHost read-only audit (2026-11-21) returned exit code 2 and missing:
`verified_deposit_evidence.event_key`, `block_hash`, `block_number`,
`token_contract`, `deposit_address`, `amount_base_units`, and
`unique:verified_deposit_evidence.event_key`. Other checked fields were present
in the limited audit; this does not establish overall deposit readiness.

## Required before production execution
1. Keep real deposits, withdrawals, settlement and credits disabled.
2. Review the exact approved revision of `migrations/20261121_verified_deposit_evidence.sql`. PR #80 is historical and must not be executed. The combined draft #207 incorporates reviewed #197 and #205 candidates; verify both contracts, independent provenance, effective privileges, immutability guards and data retention policy.
3. Rehearse against an isolated PostgreSQL 17 database with a matching schema. Test first execution, rejection of repeated execution or unexpected existing relations, concurrent execution, unique event keys, invalid event keys, zero/negative amounts, and rollback on failure.
4. Capture a verified restorable backup and recovery point before any production DDL.
5. Obtain separate explicit owner approval **for the production migration**; approval to deploy read-only diagnostics does not authorize DDL.
6. Use a private-network execution path and least-privilege migration role; do not expose the database publicly or paste credentials.
7. Run full read-only `npm run audit:deposit-schema` afterwards, check constraints and reconciliation, and retain audit results without secrets.

## Important limitations
The create-only candidate intentionally rejects any existing relation, including a compatible table. Do not retry blindly after an uncertain outcome; inspect the catalog read-only and require a separate reviewed change if repair is needed.
This migration creates evidence storage only. It does not install a blockchain
observer, prove receipt ownership, credit balances or enable financial activity.
Do not merge historical PR #80 or run either candidate solely because isolated tests passed.

### Numeric catalog review
The isolated candidate now requires unconstrained numeric for both evidence numeric fields, validated scale-zero checks, lower bounds and validated uint256 upper bounds. A numeric(78,0) typmod silently rounds fractional inputs before constraints run and is deliberately rejected by the catalog audit. PostgreSQL NaN passes ordinary positive checks but fails the finite upper bound. Existing tables are not repaired by this candidate; any missing or differently rendered constraint must be reviewed and separately migrated. No production DDL approval or financial activation is implied.

### Event identity catalog review
The combined draft now incorporates #210: require canonical lowercase transaction hashes and a canonical decimal log index from zero through uint256 maximum. PostgreSQL must enforce the bounded format, the guarded numeric ceiling, and nonzero token and deposit addresses through validated reviewed CHECK constraints. The read-only audit must reject missing, unvalidated or ineffective definitions. The application validator, offline observation, attribution, evidence store and posting entrypoint must agree on these boundaries. This is defensive validation, not independent proof of chain finality or entitlement to funds.

## Verified isolated rehearsal — 2026-11-25

At combined draft #207 head `5719226b42df79371999d567bd0fa8a0fee38bfe`, based on integration `8f75e8f0ac1b99a34545e83f4660746dcd398c4b`, all five CI workflows and ten jobs passed. Merge preview `332a6e1e5841cf81159b884b91612bbcb667510e`: Node 26 full suite 523/523 (job 139147743137), Node 22 full suite 523/523 and focused PostgreSQL suite 97/97 (job 139147742646), zero failures/skips. Job 139147742896 verified isolated PostgreSQL 17 backup and restore of both proposed schemas, with synthetic data only. This is completed free rehearsal work, not production readiness.

The historical ownership candidate requires a trusted preinstalled btree_gist extension, actual source catalog compatibility, finite independently proven intervals, verified role/ACL configuration and a separately reviewed ownership lifecycle. A basic guard inventory is not proof of full trigger definitions or effective privileges. No live production backup restore, catalog validation or financial approval is established. Retain draft until the outstanding operational and design gates are resolved. Do not execute production DDL, deploy, or enable deposits.


## Deposit identity checkpoint — 2026-11-25
PR #210 head `1544557c09b1f837a8e1cf1501867415a117ebfe` passed 68 focused unit tests, 4 safety tests and 38 PostgreSQL tests across eight suites; zero failures/skips. Job 139261298322 verified direct SQL rejection of oversized/invalid indices and zero addresses, acceptance of uint256 maximum, exact catalog compatibility and rejection of missing or weakened constraints. Backup and restore rehearsal passed on disposable PostgreSQL 17. Merged only into draft #207 at `68a72ce16172fe8906fd5b87b7ddc466e76628af`; tree matches tested #210 head. Fresh integrated matrix and operational gates remain required. No main merge, production migration or financial activation.
