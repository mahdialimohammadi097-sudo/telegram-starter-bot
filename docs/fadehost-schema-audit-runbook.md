# FadeHost read-only schema audit — existing service

The integration candidate retains the existing schedule command and delegates to the reviewed deposit catalog audit. This is not evidence that the candidate is deployed. A push to main automatically deploys the existing bot; do not merge before release review and operational approval.

## Controlled execution

Confirm the deployed commit, service health, private database connection and rollback path. Use the existing schedule command in telegram-bot:

    node scripts/fadehost-schema-audit.js

Inspect the sanitized JSON output only. If a temporary recurring schedule is used, remove it after its first execution, including on failure. Never put database credentials into the schedule or share them in logs. The command uses a bounded read-only repeatable-read transaction with the existing TLS policy, 8-second connection timeout, a verified 10-second transaction-local statement timeout, and a verified 3-second lock timeout. The shared audit wrapper verifies the effective read-only and repeatable-read settings before catalog inspection. These are per-statement limits, not a total runtime deadline.

## Interpretation

- Exit 0 / ready true: reviewed structural checks passed, including required columns, precision, nullability, immediate unique indexes, validated foreign keys and reviewed evidence CHECK definitions. This does not certify historical ownership, real balances, role isolation, network security, backup/restore or financial activation.
- Exit 2 / ready false: missing or incompatible catalog requirements. The missing array retains legacy unique: markers; incompatible provides detailed findings. Review differences before any migration.
- Exit 3: missing configuration, read-only execution failure or cleanup failure. Investigate privately using sanitized diagnostics.

Successful structural reports explicitly set financialActivationReady and realDepositsEnabled to false. Error reports never authorize financial operations. No migrations, user records, wallet balances or money movements are performed. Real operations require independent verification and separate final owner approval.

### Catalog-only snapshot resolution
Historical-wallet inspection, legacy/combined assignment audit and the one-shot FadeHost schema CLI now pin and verify transaction-local `pg_catalog, pg_temp` before inspection. Explicit application relation qualification and catalog-first resolution prevent a caller's local function/operator shadowing from concealing conflicts. The disposable historical fixture demonstrates a shadow `lower(text)` concealing a case-variant conflicting record and checks that audit rejection restores the caller search path. The runtime-role inventory intentionally continues to inspect original session settings, not a repaired path. No production DDL, role grants, financial activation or provider command. Exact-head CI required.
