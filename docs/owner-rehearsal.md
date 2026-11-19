# Owner rehearsal on the existing bot

The existing @PROFINO1bot accepts /admintest from the configured owner in their private chat. The command exercises a fixed 1 test USDT reservation and cancellation using a separate database connection.

Set PROFINO_TEST_DATABASE_URL and PROFINO_TEST_DATABASE_NAME through host secrets. The database must have profino.environment set to isolated-staging and a different current_database() name from production. Provision the existing synthetic ledger/withdrawal fixtures, an active synthetic owner with the owner's Telegram ID, and at least 1 test USDT. Keep this test owner exclusive to the rehearsal while it runs.

The command reads the production database name to check isolation. Financial operations use the test pool. Repeated processing of the same Telegram message uses the same withdrawal request key. A partial failure can leave a reserved test withdrawal which can be inspected and cancelled in that test database.

This command bypasses the need to enable global isolated-staging simulation mode for the existing bot. The generic staging adapter still retains its separate identity checks. Live investment, blockchain delivery and customer acceptance require separate validation.

The command is implemented on the release candidate. Host configuration, test-data provisioning and a live Telegram run remain outstanding.
