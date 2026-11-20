# Owner rehearsal on the existing bot

The existing @PROFINO1bot accepts /admintest from the configured owner in their private chat. The command exercises a fixed 1 test USDT reservation and cancellation using a separate database connection.

Set PROFINO_TEST_DATABASE_URL and PROFINO_TEST_DATABASE_NAME through host secrets. The database must have profino.environment set to isolated-staging and a different current_database() name from production. Provision the existing synthetic ledger/withdrawal fixtures, an active synthetic owner with the owner's Telegram ID, and at least 1 test USDT. Keep this test owner exclusive to the rehearsal while it runs.

The command reads the production database name to check isolation. Financial operations use the test pool. Repeated processing of the same Telegram message uses the same withdrawal request key. A partial failure can leave a reserved test withdrawal which can be inspected and cancelled in that test database.

This command bypasses the need to enable global isolated-staging simulation mode for the existing bot. The generic staging adapter still retains its separate identity checks. Live investment, blockchain delivery and customer acceptance require separate validation.

The command is implemented on the release candidate. Host configuration, test-data provisioning and a live Telegram run remain outstanding.

## Live catalog evidence — 2026-11-20

The owner supplied the output of the live bot's read-only /dbschema command after diagnostic PR #60 was deployed (main commit 51a462784169fd7d6de4a7bfc0cfa5e9b56ba0af). The supplied validate_posted_transaction(bigint) definition matches test/fixtures/ledger-contract.sql after removing whitespace and the public qualification on the function declaration. It rejects posted transactions with no entries, fewer than two entries per currency, or unequal debit and credit totals per currency.

The earlier supplied trigger definitions also show posted-entry and posted-transaction immutability guards. This is static catalog evidence supplied by the owner, not a newly executed production transaction test. It does not establish trigger enabled states, numeric column precision, account-currency agreement, available-balance sufficiency, or end-to-end deposit/withdrawal correctness.

Outstanding deployment prerequisites remain: confirm the relevant column precision and enabled trigger states from the enhanced report, provision the separate rehearsal database and synthetic fixtures, configure its host secrets, and execute /admintest on the existing bot after release review. Do not recreate or weaken production guards merely because the full release candidate remains undeployed.
