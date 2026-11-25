-- PROFINO: read-only production catalog evidence for deposit release review.
-- Execute only with a database role that has SELECT/catalog read permissions.
-- Never paste database credentials or user wallet assignments into PR logs.
-- No DDL, DML, migrations, writes, or live financial activation.
BEGIN TRANSACTION READ ONLY;
SET LOCAL statement_timeout = '15s';

-- Table and column contract, including numeric precision and nullability.
SELECT table_name,column_name,data_type,numeric_precision,numeric_scale,is_nullable
FROM information_schema.columns
WHERE table_schema='public'
  AND table_name IN ('users','wallets','user_wallet_assignments',
    'wallet_transfers','deposit_requests','ledger_accounts',
    'ledger_transactions','ledger_entries','verified_deposit_evidence')
ORDER BY table_name,ordinal_position;

-- Unique index validity and scope: event identity and transaction idempotency.
SELECT t.relname AS table_name,i.relname AS index_name,
       x.indisunique,x.indisvalid,x.indisready,
       x.indpred IS NULL AS unfiltered,x.indexprs IS NULL AS plain_column,
       x.indnkeyatts AS key_count,pg_get_indexdef(i.oid) AS definition
FROM pg_index x
JOIN pg_class t ON t.oid=x.indrelid
JOIN pg_namespace n ON n.oid=t.relnamespace
JOIN pg_class i ON i.oid=x.indexrelid
WHERE n.nspname='public'
  AND t.relname IN ('verified_deposit_evidence','ledger_transactions',
                   'wallets','user_wallet_assignments')
ORDER BY t.relname,i.relname;

-- Actual validated constraints and definitions, not just expected names.
SELECT t.relname AS table_name,c.conname,c.contype,c.convalidated,
       pg_get_constraintdef(c.oid,true) AS definition
FROM pg_constraint c
JOIN pg_class t ON t.oid=c.conrelid
JOIN pg_namespace n ON n.oid=t.relnamespace
WHERE n.nspname='public'
  AND t.relname IN ('verified_deposit_evidence','wallets',
                    'user_wallet_assignments','ledger_accounts',
                    'ledger_transactions','ledger_entries')
ORDER BY t.relname,c.contype,c.conname;

-- Server metadata only; does not expose credentials or user records.
SELECT current_database() AS database_name,
       current_setting('server_version') AS server_version,
       current_schema() AS schema_name;

ROLLBACK;
