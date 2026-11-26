-- Run on the existing FadeHost PostgreSQL database with a read-only role.
-- Schema metadata only: no customer rows, addresses, balances or credentials.
BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;
SET LOCAL statement_timeout = '10s';
SET LOCAL lock_timeout = '2s';
SET LOCAL search_path = pg_catalog, pg_temp;
SELECT current_setting('server_version') AS postgres_version, 'public' AS inspected_schema;
SELECT table_name, column_name, data_type, udt_name, is_nullable, column_default,
       numeric_precision, numeric_scale
FROM information_schema.columns
WHERE table_schema = 'public' AND table_name IN
  ('users','wallets','user_wallet_assignments','wallet_transfers','deposit_requests',
   'withdrawal_requests','investments','ledger_accounts','ledger_transactions','ledger_entries',
   'verified_deposit_evidence','deposit_address_ownership_history')
ORDER BY table_name, ordinal_position;
SELECT c.relname AS table_name, con.conname, con.contype,
       pg_get_constraintdef(con.oid) AS definition
FROM pg_constraint con JOIN pg_class c ON c.oid=con.conrelid
JOIN pg_namespace n ON n.oid=c.relnamespace
WHERE n.nspname='public' AND c.relname IN
  ('users','wallets','user_wallet_assignments','wallet_transfers','deposit_requests',
   'withdrawal_requests','investments','ledger_accounts','ledger_transactions','ledger_entries',
   'verified_deposit_evidence','deposit_address_ownership_history')
ORDER BY c.relname, con.conname;
SELECT tablename, indexname, indexdef FROM pg_indexes
WHERE schemaname='public' AND tablename IN
  ('wallets','user_wallet_assignments','wallet_transfers','deposit_requests',
   'withdrawal_requests','investments','ledger_accounts','ledger_transactions','ledger_entries',
   'verified_deposit_evidence','deposit_address_ownership_history')
ORDER BY tablename,indexname;
SELECT c.relname AS table_name, t.tgname, pg_get_triggerdef(t.oid) AS trigger_definition,
       pg_get_functiondef(t.tgfoid) AS function_definition
FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid
JOIN pg_namespace n ON n.oid=c.relnamespace
WHERE NOT t.tgisinternal AND n.nspname='public' AND c.relname IN
  ('wallets','user_wallet_assignments','wallet_transfers','deposit_requests',
   'withdrawal_requests','investments','ledger_accounts','ledger_transactions','ledger_entries',
   'verified_deposit_evidence','deposit_address_ownership_history')
ORDER BY c.relname,t.tgname;
ROLLBACK;
