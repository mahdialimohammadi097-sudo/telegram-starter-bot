// Read-only evidence of the CURRENT connection's role and transport.
// No role names, hostnames, credentials or financial records are returned.
export async function inspectDatabaseAccess(client) {
  const { rows } = await client.query(`
    SELECT
      current_setting('transaction_read_only') = 'on' AS read_only,
      current_setting('server_version_num')::int / 10000 AS server_major,
      COALESCE((SELECT ssl FROM pg_catalog.pg_stat_ssl WHERE pid = pg_backend_pid()), false) AS tls,
      EXISTS (
        SELECT 1 FROM pg_catalog.pg_roles r
        WHERE pg_has_role(current_user, r.oid, 'MEMBER')
          AND (r.rolsuper OR r.rolcreaterole OR r.rolcreatedb OR r.rolreplication OR r.rolbypassrls)
      ) AS privileged_role_membership,
      EXISTS (
        SELECT 1 FROM pg_catalog.pg_namespace n
        WHERE n.nspname = 'public' AND has_schema_privilege(current_user, n.oid, 'CREATE')
      ) AS public_schema_create,
      count(c.oid)::int AS ledger_tables_present,
      count(c.oid) FILTER (WHERE pg_has_role(current_user, c.relowner, 'MEMBER'))::int AS ledger_tables_owned,
      count(c.oid) FILTER (WHERE has_table_privilege(current_user, c.oid, 'TRUNCATE'))::int AS ledger_tables_truncatable,
      count(c.oid) FILTER (WHERE has_table_privilege(current_user, c.oid, 'TRIGGER'))::int AS ledger_tables_trigger_privilege
    FROM pg_catalog.pg_class c
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind IN ('r','p')
      AND c.relname IN ('ledger_accounts','ledger_transactions','ledger_entries')
  `);
  if (rows.length !== 1) throw new Error("Database access audit returned unexpected result");
  const row = rows[0];
  const flags = ["read_only","tls","privileged_role_membership","public_schema_create"];
  const counts = ["ledger_tables_present","ledger_tables_owned","ledger_tables_truncatable","ledger_tables_trigger_privilege"];
  if (flags.some(key => typeof row[key] !== "boolean") ||
      !Number.isInteger(row.server_major) || row.server_major < 1 ||
      counts.some(key => !Number.isInteger(row[key]) || row[key] < 0 || row[key] > 3) ||
      counts.slice(1).some(key => row[key] > row.ledger_tables_present) || !row.read_only) {
    throw new Error("Database access audit evidence is incomplete or unsafe");
  }
  // Findings describe only this DSN, not every role or the hosting network.
  return Object.freeze(Object.fromEntries([...flags,"server_major",...counts].map(key => [key,row[key]])));
}
