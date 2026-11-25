// Exact reviewed lock-only function body; no input, dynamic SQL or writes.
// Runtime receives only the owner's internal ID while the membership row is locked.
export function activeOwnerLockBody(schema = "public") {
  if (typeof schema !== "string" || !/^[a-z_][a-z0-9_]{0,62}$/.test(schema)) throw new Error("Invalid runtime schema");
  return `SELECT au.user_id::bigint
FROM "${schema}".admin_users au
JOIN "${schema}".users u ON u.id = au.user_id
WHERE u.telegram_id = 8810232463 AND au.role = 'owner' AND au.status = 'active'
LIMIT 1 FOR SHARE OF au, u`;
}
export async function verifyActiveOwnerLock(client, schema) {
  const result = await client.query(`
    SELECT p.prosrc, p.prosecdef, p.provolatile, p.proretset, p.prokind,
      p.prorettype = 'pg_catalog.int8'::regtype AS bigint_result,
      l.lanname, p.proconfig,
      pg_catalog.pg_has_role(current_user, p.proowner, 'MEMBER') AS runtime_owns,
      pg_catalog.has_function_privilege(current_user, p.oid, 'EXECUTE') AS runtime_execute,
      pg_catalog.has_function_privilege(current_user, p.oid, 'EXECUTE WITH GRANT OPTION') AS runtime_can_delegate,
      EXISTS (SELECT 1 FROM pg_catalog.aclexplode(COALESCE(p.proacl, pg_catalog.acldefault('f', p.proowner))) a
        WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE') AS public_execute
    FROM pg_catalog.pg_proc p
    JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
    JOIN pg_catalog.pg_language l ON l.oid = p.prolang
    WHERE n.nspname = $1 AND p.proname = 'profino_lock_active_owner' AND p.pronargs = 0
  `, [schema]);
  const row = result.rows?.[0];
  if (result.rows?.length !== 1 || row?.prosrc !== activeOwnerLockBody(schema) ||
      row.prosecdef !== true || row.provolatile !== "v" || row.proretset !== false ||
      row.prokind !== "f" || row.bigint_result !== true || row.lanname !== "sql" ||
      !Array.isArray(row.proconfig) || row.proconfig.length !== 1 ||
      row.proconfig[0] !== "search_path=pg_catalog, pg_temp" ||
      row.runtime_owns !== false || row.runtime_execute !== true || row.runtime_can_delegate !== false || row.public_execute !== false) {
    throw new Error("Required restricted owner lock is missing or incompatible");
  }
}
