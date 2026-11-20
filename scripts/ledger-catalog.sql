-- Run with psql -XqAt -v ON_ERROR_STOP=1 -f scripts/ledger-catalog.sql.
-- Compare outputs from PostgreSQL 17 databases using the public schema.
BEGIN READ ONLY;
SET LOCAL search_path = pg_catalog, public;
WITH ledger AS (
  SELECT c.oid, c.relname FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND c.relkind IN ('r','p')
    AND c.relname IN ('ledger_accounts','ledger_transactions','ledger_entries')
), objects(kind, object_name, definition) AS (
  SELECT 'table', relname::text, to_jsonb(relname) FROM ledger
  UNION ALL
  SELECT 'column', l.relname || '.' || a.attname,
    jsonb_build_array(format_type(a.atttypid,a.atttypmod), a.attnotnull, a.attidentity,
      a.attgenerated, pg_get_expr(d.adbin,d.adrelid))
  FROM ledger l JOIN pg_attribute a ON a.attrelid=l.oid
  LEFT JOIN pg_attrdef d ON d.adrelid=l.oid AND d.adnum=a.attnum
  WHERE a.attnum>0 AND NOT a.attisdropped
  UNION ALL
  SELECT 'constraint', l.relname || '.' || c.conname,
    jsonb_build_array(pg_get_constraintdef(c.oid), c.convalidated)
  FROM ledger l JOIN pg_constraint c ON c.conrelid=l.oid
  UNION ALL
  SELECT 'index', l.relname || '.' || i.relname,
    jsonb_build_array(pg_get_indexdef(i.oid), x.indisvalid, x.indisready)
  FROM ledger l JOIN pg_index x ON x.indrelid=l.oid JOIN pg_class i ON i.oid=x.indexrelid
  UNION ALL
  SELECT 'trigger', l.relname || '.' || t.tgname,
    jsonb_build_array(pg_get_triggerdef(t.oid), t.tgenabled, pg_get_functiondef(t.tgfoid))
  FROM ledger l JOIN pg_trigger t ON t.tgrelid=l.oid WHERE NOT t.tgisinternal
  UNION ALL
  SELECT 'helper', 'public.validate_posted_transaction(bigint)', to_jsonb(pg_get_functiondef(p.oid))
  FROM pg_proc p WHERE p.oid=to_regprocedure('public.validate_posted_transaction(bigint)')
)
SELECT jsonb_build_array(kind,object_name,definition)::text
FROM objects ORDER BY kind COLLATE "C",object_name COLLATE "C";
COMMIT;
