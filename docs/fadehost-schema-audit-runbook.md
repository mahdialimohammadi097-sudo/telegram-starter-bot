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

### Startup and manual catalog alignment
Exact predecessor b4af975 passed all six workflows, full 620/620, focused 148/148, required 23/21 and synthetic restore checks (Node 22 job 139848005181). The startup metadata diagnostic now calls the same verified catalog-path helper before its first metadata query, preserves its existing five-second statement/three-second lock limits and rollback/discard behavior, and rejects path-setting or effective-value failure. Unit regressions exercise both. The existing operator SQL script also pins catalog-first resolution, repeatable-read/read-only isolation and bounded statement/lock waits; its report names the inspected public schema separately from the effective search path. The manual script is not executed against production in this change. The runtime-role verification still inspects original settings. No production DDL, grant, deployment or financial operation. Exact-head CI required.

### Remaining standalone audit entrypoints
Exact predecessor 05b2a6c passed six workflows/eight jobs, full 622/622, focused 148/148, 23/21 named checks, no failed/skipped/cancelled/todo and synthetic recovery (Node 22 job 139850239380). The default `audit:deposit-schema` CLI and standalone ledger trigger catalog audit now use the existing verified catalog snapshot helper, matching the already-protected combined paths. CLI subprocess mock covers valid metadata inspection and path drift refusal; existing disposable PostgreSQL operator-shadow fixture additionally verifies the standalone trigger report and caller path restoration. The restricted runtime inventory still observes original session settings. No production execution or changes; exact-head CI required.

### Current-connection access evidence
Exact predecessor 9005057 passed all six workflows/eight jobs: 623 full, 148 focused, 23/21 required named tests and synthetic recovery (Node 22 job 139858371449). The current-connection privilege audit CLI now verifies catalog-first resolution inside its read-only snapshot rather than relying on startup options alone. The CLI path-drift case rejects before reporting; disposable PostgreSQL checks demonstrate a caller's shadow name equality cannot falsify the session/current-role comparison and that the original path returns afterward. Role identity, effective grants and transport remain observations, not production approval. The restricted runtime inventory remains unchanged. No production execution or changes. Exact-head CI required.

### Current-connection ledger relation shape evidence
Exact predecessor 2fb8d59 passed six workflows/eight jobs (625 full and 149 focused; Node 22 job 139866416346). The access audit now additionally reports whether existing expected ledger names resolve to ordinary permanent non-partition relations in the inspected schema. An incompatible object produces a negative shape finding; the existing privilege counts are unchanged and missing relations are still represented by the table count. True shape compatibility alone is not evidence of completeness or readiness. Disposable PostgreSQL fixtures cover absent, unlogged, partitioned, view and ordinary relations; CLI evidence remains explicitly non-activating. No production audit or changes. Exact-head CI required.

### Standalone ledger integrity relation preflight
Exact predecessor 66004dd passed six workflows/eight jobs, 628 full/150 focused, zero failures/skips/cancellations/todo, and synthetic recovery (Node 22 job 139880411606). The standalone integrity scan now verifies exactly three permanent ordinary relations without inheritance or rewrite rules inside its existing read-only snapshot before scanning rows. Missing, view, unlogged, inherited and rewrite-rule fixtures cannot yield a clean result. This is a relation visibility preflight, not full column/constraint, custody, runtime-role or recovery proof. The combined release audit keeps its existing stricter catalog checks. Unit and disposable PostgreSQL tests added. Exact-head CI pending; no production execution or change.
