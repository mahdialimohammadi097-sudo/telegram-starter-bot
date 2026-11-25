# Verified deposit evidence: production migration gate

Live FadeHost read-only audit (2026-11-21) returned exit code 2 and missing:
`verified_deposit_evidence.event_key`, `block_hash`, `block_number`,
`token_contract`, `deposit_address`, `amount_base_units`, and
`unique:verified_deposit_evidence.event_key`. Other checked fields were present
in the limited audit; this does not establish overall deposit readiness.

## Required before production execution
1. Keep real deposits, withdrawals, settlement and credits disabled.
2. Review candidate `migrations/20261121_verified_deposit_evidence.sql` on PR #80; verify the chain-specific event-key contract and data retention/security policy.
3. Rehearse against an isolated PostgreSQL 17 database with a matching schema. Test first execution, rejection of repeated execution or unexpected existing relations, concurrent execution, unique event keys, invalid event keys, zero/negative amounts, and rollback on failure.
4. Capture a verified restorable backup and recovery point before any production DDL.
5. Obtain separate explicit owner approval **for the production migration**; approval to deploy read-only diagnostics does not authorize DDL.
6. Use a private-network execution path and least-privilege migration role; do not expose the database publicly or paste credentials.
7. Run full read-only `npm run audit:deposit-schema` afterwards, check constraints and reconciliation, and retain audit results without secrets.

## Important limitations
The create-only candidate intentionally rejects any existing relation, including a compatible table. Do not retry blindly after an uncertain outcome; inspect the catalog read-only and require a separate reviewed change if repair is needed.
This migration creates evidence storage only. It does not install a blockchain
observer, prove receipt ownership, credit balances or enable financial activity.
Do not merge PR #80 merely to apply the migration.

### Numeric catalog review
The isolated candidate now requires unconstrained numeric for both evidence numeric fields, validated scale-zero checks, lower bounds and validated uint256 upper bounds. A numeric(78,0) typmod silently rounds fractional inputs before constraints run and is deliberately rejected by the catalog audit. PostgreSQL NaN passes ordinary positive checks but fails the finite upper bound. Existing tables are not repaired by this candidate; any missing or differently rendered constraint must be reviewed and separately migrated. No production DDL approval or financial activation is implied.
