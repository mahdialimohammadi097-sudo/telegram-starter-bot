// Read-only evidence of the CURRENT connection's role and transport.
// No role names, hostnames, credentials or financial records are returned.
export async function inspectDatabaseAccess(client,{schema="public"}={}) {
  if(typeof schema!=="string"||!/^[a-z_][a-z0-9_]{0,62}$/.test(schema)) {
    throw new Error("Invalid database access audit schema");
  }
  const { rows } = await client.query(`
    SELECT
      current_setting('transaction_read_only') = 'on' AS read_only,
      current_user = session_user AS session_role_matches,
      pg_catalog.has_parameter_privilege(current_user,'session_replication_role','SET') AS can_set_replication_role,
      current_setting('session_replication_role') = 'origin' AS replication_role_origin,
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
      count(c.oid) FILTER (WHERE has_table_privilege(current_user, c.oid, 'TRIGGER'))::int AS ledger_tables_trigger_privilege,
      count(c.oid) FILTER (WHERE has_any_column_privilege(current_user,c.oid,'INSERT'))::int AS ledger_tables_insertable,
      count(c.oid) FILTER (WHERE has_any_column_privilege(current_user,c.oid,'UPDATE'))::int AS ledger_tables_updatable,
      count(c.oid) FILTER (WHERE has_table_privilege(current_user,c.oid,'DELETE'))::int AS ledger_tables_deletable,
      count(c.oid) FILTER (WHERE c.relrowsecurity)::int AS ledger_tables_rls_enabled,
      count(c.oid) FILTER (WHERE
        has_table_privilege(current_user,c.oid,'INSERT WITH GRANT OPTION,UPDATE WITH GRANT OPTION,DELETE WITH GRANT OPTION,TRUNCATE WITH GRANT OPTION,TRIGGER WITH GRANT OPTION')
        OR has_any_column_privilege(current_user,c.oid,'INSERT WITH GRANT OPTION,UPDATE WITH GRANT OPTION')
      )::int AS ledger_tables_delegable,
      count(c.oid) FILTER (WHERE EXISTS (
        SELECT 1 FROM pg_catalog.aclexplode(c.relacl) acl
        WHERE acl.grantee=0 AND acl.privilege_type IN ('INSERT','UPDATE','DELETE','TRUNCATE','TRIGGER')
      ) OR EXISTS (
        SELECT 1 FROM pg_catalog.pg_attribute a
        CROSS JOIN LATERAL pg_catalog.aclexplode(a.attacl) acl
        WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped
          AND acl.grantee=0 AND acl.privilege_type IN ('INSERT','UPDATE')
      ))::int AS ledger_tables_public_write
    FROM pg_catalog.pg_class c
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = $1 AND c.relkind IN ('r','p')
      AND c.relname IN ('ledger_accounts','ledger_transactions','ledger_entries')
  `,[schema]);
  if (rows.length !== 1) throw new Error("Database access audit returned unexpected result");
  const row = rows[0];
  const flags = ["read_only","tls","privileged_role_membership","public_schema_create",
    "session_role_matches","can_set_replication_role","replication_role_origin"];
  const counts = ["ledger_tables_present","ledger_tables_owned","ledger_tables_truncatable","ledger_tables_trigger_privilege",
    "ledger_tables_insertable","ledger_tables_updatable","ledger_tables_deletable","ledger_tables_rls_enabled",
    "ledger_tables_delegable","ledger_tables_public_write"];
  if (flags.some(key => typeof row[key] !== "boolean") ||
      !Number.isInteger(row.server_major) || row.server_major < 1 ||
      counts.some(key => !Number.isInteger(row[key]) || row[key] < 0 || row[key] > 3) ||
      counts.slice(1).some(key => row[key] > row.ledger_tables_present) || !row.read_only) {
    throw new Error("Database access audit evidence is incomplete or unsafe");
  }
  // Findings describe only this DSN, not every role or the hosting network.
  return Object.freeze(Object.fromEntries([...flags,"server_major",...counts].map(key => [key,row[key]])));
}
