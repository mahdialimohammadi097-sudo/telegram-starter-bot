# PROFINO priority 7 checkpoint and priority 8 release decision

**NO-GO: real customer funds.** Review-only branch; do not deploy, apply production migrations, or enable financial operations.

## Independently retrieved GitHub evidence (2026-11-25 UTC)

- Main HEAD: `e0d7509b43605493beb6a20485d5d17ce0ef8e16` (repository state, not verified running revision).
- Cumulative review candidate PR #224: `4f3bdea6b1be46e80d6d3b4e4f885f6a5c5791ed`, base `36b6285b8ca53198ccb38dd554ba76812af91ac1`. GitHub reports 12/12 checks successful; 124 commits ahead, zero behind that base; 64 changed files. Mergeable does not mean reviewed or authorized.
- [Node 22 full/focused matrix](https://github.com/mahdialimohammadi097-sudo/telegram-starter-bot/actions/runs/45696537726/job/139495290337): 585/585 and 138/138, zero fail/cancel/skip/todo; both reports explicitly contain nine critical PostgreSQL regressions. Focused subset overlaps full suite.
- [Node 26 matrix](https://github.com/mahdialimohammadi097-sudo/telegram-starter-bot/actions/runs/45696537726/job/139495290085): 585/585; nine critical tests present.
- [Integration validator Node 22](https://github.com/mahdialimohammadi097-sudo/telegram-starter-bot/actions/runs/45696537385/job/139495289550): 585/585 full, 138/138 focused, dependency audit found zero known vulnerabilities at run time.
- Credential scan, ownership, concurrency, safe audit and synthetic restore checks passed on that candidate.
- Reviewed main and candidate source trees: migration files are absent from main; candidate contains three migration SQL files, including two review-only files. Candidate runtime verifies authenticated bot and isolated DB before staging handler injection; customer transfer text explicitly disables real funds. No deployment inferred.
- #224 includes earlier cumulative review PRs; do not merge overlapping PRs independently. Keep exact tested revision separate from subsequent documentation edits.

## Release evidence matrix

| Gate | Status | Evidence / limitation |
|---|---|---|
| Disposable test matrix and synthetic scenarios | PASS for exact tested candidate | Above logs and check runs; includes concurrency, ambiguous commits, corruption and reconciliation |
| Dependency and credential checks | PASS for exact candidate | CI only, not independent penetration testing or proof that secrets are safe |
| Full cumulative dependency and integration review | OPEN | 64-path diff against integration baseline; review final target merge commit, not draft mergeability |
| Actual deployed revision, health, private networking | UNVERIFIED | Repository HEAD is not deployment evidence; current direct FadeHost connector not available; plugin discovery returned no FadeHost result; external uptime workflow run listing rejected by GitHub connector |
| Actual PostgreSQL catalog, functions, permissions and RLS | OPEN | No current private catalog evidence; test fixtures cannot substitute; production migration approval separate |
| Actual encrypted backup and isolated restore | OPEN | Successful synthetic restore only; no verified production backup restoration |
| Chain verification, custody, accessible liquidity and liabilities | OPEN | No real transfer or authenticated backing evidence; economic and applicable compliance review required |
| Live isolated operational acceptance and incident recovery | OPEN | Offline Telegram and PostgreSQL test evidence only; no new staging bot or paid service created |
| Owner approval | NOT REQUESTED | Final separate authorization only after all gates and independent safety review |

## Operational boundaries

Keep financial functions disabled. Do not request or expose credentials. Do not turn public database access on, restore over production, run review fixtures on live data, or use a test run as permission for money movement. No production or financial change was made by this checkpoint. No new cost incurred.

Next free work: review current production access evidence and reconcile remaining code-level release gaps without altering the deployed service. When the exact target revision changes, refresh all CI evidence. The remaining operational gates may require provider access or an isolated restore target; do not bypass paid-plan restrictions.

## Operator ledger evidence command (review candidate only)

After an authorized private execution path and exact candidate availability are confirmed, `node scripts/audit-ledger-release.js` runs the existing ledger integrity and trigger-shape audits. It emits one sanitized JSON report, uses one bounded repeatable-read, read-only transaction for both components, requires three permanent ordinary ledger tables, and reports `sameSnapshot:true`. Exit 0 means both limited checks passed, 2 means a finding, 3 means unavailable/cleanup failure. All results keep financialActivationReady and productionReady false. This is not a backup, a function-body/role audit, custody verification or release authorization. No production execution has taken place.

The combined ledger evidence also compares the exact trimmed bodies and basic metadata of the three trigger functions and their balance-validation helper against the historical reviewed ledger fixture. A mismatch blocks diagnostic success; a legitimate alternative requires separate review, not automatic replacement. Matching text does not prove actual function resolution, grants, search paths, or operational correctness. No production function is modified or displayed.

The trigger shape check additionally rejects any unreviewed non-internal trigger on all three ledger tables, including disabled hooks. Only the number of unexpected hooks is reported; internal foreign-key triggers remain outside this check. An additional legitimate hook requires separate review. This does not verify rewrite rules, privileges, or effective function resolution.

The combined audit now rejects inheritance links in either direction and any rewrite rule on the three ledger relations before scanning their rows. This is a conservative fixture-based guard; legitimate nonstandard topology requires separate review. Only fixed errors or boolean evidence are emitted. The disposable test adds and removes an empty inherited table and a rewrite rule; no live DDL is performed. Grants, effective function resolution, and production readiness remain unverified.

The combined release diagnostic also requires six reviewed primary/unique identity constraints backed by live, ready, valid, immediate, nonpartial unique indexes. An empty ledger no longer hides missing or deferred idempotency uniqueness. It reports only fixed reviewed identities and compatibility booleans. The disposable regression removes, defers and restores the idempotency constraint. This is not a complete schema or permission audit; nullable idempotency keys, foreign keys, check constraints and application-side replay semantics require independent evidence. No production schema was changed.

The read-only release diagnostic additionally requires the three reviewed single-column foreign keys, the expected same-schema targets, validated immediate NO ACTION constraints and four enabled internal enforcement triggers per reference. It rejects missing, unvalidated or cascading replacements in the disposable fixture. This is a narrow catalog comparison, not a complete constraint/role audit or proof of runtime enforcement in a privileged session. It does not inspect all additional constraints. No live DDL or financial activity occurred.

The diagnostic now compares 20 reviewed column types, nullability and ordinary/built-in storage, including exact numeric(36,18) storage for amount, before aggregating. The existing row audit continues to enforce the application precision of at most eight fractional digits; storage scale alone does not enforce it. It additionally checks the validated historical positive-amount CHECK expression, not the constraint name. A nullable idempotency key is explicitly reported as a remaining historical schema gap, not silently presented as fully secure. Disposable regressions exercise reduced precision, missing NOT NULL, missing/permissive/unvalidated amount checks and restoration. Finite-value, currency and status/direction schema constraints, effective permissions and operational safety remain separate gates. No production DDL occurred.

The combined read-only diagnostic also compares the two historical single-column direction/status CHECK expressions, requiring validated constraints and the exact reviewed allowed-value lists. Quoted literal contents are preserved during formatting normalization. Disposable regression covers missing, whitespace-altered literal, expanded and unvalidated constraints, then restores the fixture. This does not prove valid state transitions, non-null idempotency enforcement, finite-value/currency enforcement or actual runtime role safety. No operational schema changes occurred.

Row-level integrity now also counts unused accounts whose currency is not USDT, whitespace-only transaction identities (including tabs/newlines) and nonblank identities padded with whitespace. The new counts are validated as nonnegative decimal strings and must be zero. The disposable regression additionally confirms that historical positive numeric CHECKs alone may admit NaN and the row audit rejects nonfinite entries even if both sides match. No user values or identity strings are emitted. This does not install live schema constraints, repair data, or establish actual backing or runtime authorization.

### Restore coverage checkpoint (2026-11-26)
The corrective candidate `92947febea0b570e697cfb20f1de9130ac2ed8ac` restored exact lockfile parity with pinned rollback reference aeefcc9. GitHub run 45774062837, job 139753329936, independently confirmed both the dependency comparison and synthetic PostgreSQL 17 dump/restore successful. This is not a real production backup. The rollback workflow previously filtered PRs by a partial set of paths, omitting transitive runtime helpers. Remove that path filter so each PR receives the isolated rehearsal, without changing the pinned reference, lock comparison, read-only workspace, credential policy or network isolation. Add regression assertions for these requirements. Exact new-head CI remains required; no merge or production deployment is authorized. The broad cumulative PR #226 remains draft and needs full integration review, actual operational database evidence and independent safety approval.
