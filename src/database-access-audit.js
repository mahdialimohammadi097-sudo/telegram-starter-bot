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
      EXISTS (
        SELECT 1 FROM pg_catalog.pg_roles r
        WHERE r.rolname<>session_user AND pg_catalog.pg_has_role(session_user,r.oid,'SET')
      ) AS session_can_assume_other_role,
      EXISTS (
        SELECT 1 FROM pg_catalog.pg_proc p
        JOIN pg_catalog.pg_namespace fn ON fn.oid=p.pronamespace
        WHERE fn.nspname=$1 AND p.prokind IN ('f','p') AND p.prosecdef
          AND pg_catalog.has_schema_privilege(current_user,fn.oid,'USAGE')
          AND pg_catalog.has_function_privilege(current_user,p.oid,'EXECUTE')
      ) AS schema_callable_security_definer,
      EXISTS (
        SELECT 1 FROM pg_catalog.pg_proc p
        JOIN pg_catalog.pg_namespace fn ON fn.oid=p.pronamespace
        WHERE fn.nspname=$1 AND p.prokind='f'
          AND p.proname IN ('validate_posted_transaction','check_ledger_balance','protect_posted_entries','protect_posted_transaction')
          AND pg_catalog.pg_has_role(session_user,p.proowner,'SET')
      ) AS session_can_assume_ledger_function_owner,
      EXISTS (
        SELECT 1 FROM pg_catalog.pg_proc p
        JOIN pg_catalog.pg_namespace fn ON fn.oid=p.pronamespace
        CROSS JOIN LATERAL pg_catalog.aclexplode(COALESCE(p.proacl,pg_catalog.acldefault('f',p.proowner))) acl
        WHERE fn.nspname=$1 AND p.prokind='f'
          AND p.proname IN ('validate_posted_transaction','check_ledger_balance','protect_posted_entries','protect_posted_transaction')
          AND acl.grantee=0 AND acl.privilege_type='EXECUTE'
      ) AS ledger_functions_public_execute,
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
      count(c.oid) FILTER (WHERE pg_catalog.pg_has_role(session_user,c.relowner,'SET'))::int AS ledger_tables_session_owner_access,
      count(c.oid) FILTER (WHERE has_table_privilege(current_user, c.oid, 'TRUNCATE'))::int AS ledger_tables_truncatable,
      count(c.oid) FILTER (WHERE has_table_privilege(current_user, c.oid, 'TRIGGER'))::int AS ledger_tables_trigger_privilege,
      count(c.oid) FILTER (WHERE has_any_column_privilege(current_user,c.oid,'INSERT'))::int AS ledger_tables_insertable,
      count(c.oid) FILTER (WHERE has_any_column_privilege(current_user,c.oid,'UPDATE'))::int AS ledger_tables_updatable,
      count(c.oid) FILTER (WHERE has_table_privilege(current_user,c.oid,'DELETE'))::int AS ledger_tables_deletable,
      count(c.oid) FILTER (WHERE c.relrowsecurity)::int AS ledger_tables_rls_enabled,
      count(c.oid) FILTER (WHERE c.relrowsecurity AND c.relforcerowsecurity)::int AS ledger_tables_rls_forced,
      count(c.oid) FILTER (WHERE c.relrowsecurity AND pg_catalog.row_security_active(c.oid))::int AS ledger_tables_rls_active,
      count(c.oid) FILTER (WHERE EXISTS (
        SELECT 1 FROM pg_catalog.pg_policy p WHERE p.polrelid=c.oid
      ))::int AS ledger_tables_with_policies,
      count(c.oid) FILTER (WHERE EXISTS (
        SELECT 1 FROM pg_catalog.pg_policy p WHERE p.polrelid=c.oid
          AND p.polpermissive AND 0::oid=ANY(p.polroles)
          AND p.polcmd IN ('*','a','w','d')
      ))::int AS ledger_tables_public_write_policy,
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
    "session_role_matches","can_set_replication_role","replication_role_origin",
    "session_can_assume_other_role","schema_callable_security_definer",
    "session_can_assume_ledger_function_owner","ledger_functions_public_execute"];
  const counts = ["ledger_tables_present","ledger_tables_owned","ledger_tables_truncatable","ledger_tables_trigger_privilege",
    "ledger_tables_insertable","ledger_tables_updatable","ledger_tables_deletable","ledger_tables_rls_enabled",
    "ledger_tables_delegable","ledger_tables_public_write","ledger_tables_session_owner_access",
    "ledger_tables_rls_forced","ledger_tables_rls_active","ledger_tables_with_policies",
    "ledger_tables_public_write_policy"];
  if (flags.some(key => typeof row[key] !== "boolean") ||
      !Number.isInteger(row.server_major) || row.server_major < 1 ||
      counts.some(key => !Number.isInteger(row[key]) || row[key] < 0 || row[key] > 3) ||
      counts.slice(1).some(key => row[key] > row.ledger_tables_present) ||
      row.ledger_tables_rls_active > row.ledger_tables_rls_enabled ||
      row.ledger_tables_rls_forced > row.ledger_tables_rls_enabled ||
      row.ledger_tables_public_write_policy > row.ledger_tables_with_policies || !row.read_only) {
    throw new Error("Database access audit evidence is incomplete or unsafe");
  }
  // Findings describe only this DSN, not every role or the hosting network.
  return Object.freeze(Object.fromEntries([...flags,"server_major",...counts].map(key => [key,row[key]])));
}
