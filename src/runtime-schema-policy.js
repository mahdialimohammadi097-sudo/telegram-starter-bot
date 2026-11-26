import { runReadOnlyDepositAudit } from "./read-only-deposit-audit.js";
import { verifyActiveOwnerLock } from "./restricted-owner-lock.js";
import { postHistoryTriggerBody } from "./post-history-trigger-body.js";

// The existing production startup contract is retained during transition.
// Restricted deployments must opt into verify-only after reviewed preparation.
// This check covers operational admin/post objects, NOT financial readiness.
const required = Object.freeze({
  users: ["id", "telegram_id", "status", "username", "first_name", "last_name", "referral_code", "created_at"],
  ledger_accounts: ["id", "user_id", "account_code", "account_type", "currency"],
  ledger_transactions: ["id", "status", "transaction_type", "reference_id", "created_at"],
  ledger_entries: ["id", "transaction_id", "account_id", "entry_type", "amount", "currency"],
  scheduled_posts: ["id", "title", "content", "status", "scheduled_at", "updated_at", "created_at", "preview_message_id", "preview_chat_id", "approved_by", "published_message_id", "published_at", "cancelled_at", "cancellation_reason", "edit_version", "last_edited_at"],
  scheduled_post_history: ["id", "post_id", "event_type", "old_status", "new_status", "details", "changed_at"],
  admin_users: ["user_id", "role", "status"],
  admin_preferences: ["user_id", "language", "updated_at"],
  admin_audit_logs: ["id", "admin_user_id", "actor_telegram_id", "action", "target_user_id", "currency", "metadata", "details", "created_at"]
});
// Exact write columns used by existing non-financial runtime statements.
// Keep identity, existing ledger and audit history immutable to this role.
const insertColumns = {
 users: ["telegram_id","username","first_name","last_name","referral_code","status"],
 ledger_accounts: ["user_id","account_code","account_type","currency"],
 scheduled_posts: ["title","content","scheduled_at","status"],
 scheduled_post_history: ["post_id","event_type","old_status","new_status","details"],
 admin_preferences: ["user_id","language","updated_at"],
 admin_audit_logs: ["admin_user_id","actor_telegram_id","action","target_user_id","currency","metadata","details"]
};
const updateColumns = {
 users: ["username","first_name","last_name","referral_code","status"],
 scheduled_posts: ["title","content","status","scheduled_at","updated_at","preview_message_id","preview_chat_id","approved_by","published_message_id","published_at","cancelled_at","cancellation_reason","edit_version","last_edited_at"],
 admin_preferences: ["language","updated_at"]
};
const generatedIdTables = ["users","ledger_accounts","scheduled_posts","scheduled_post_history","admin_audit_logs"];

export function runtimeSchemaMode(env = process.env) {
  const mode = env.PROFINO_RUNTIME_SCHEMA_MODE ?? "legacy-prepare";
  if (!["legacy-prepare","verify-only"].includes(mode)) {
    throw new Error("Invalid runtime schema mode");
  }
  return mode;
}

export async function verifyRuntimeSchema(pool, { schema = "public" } = {}) {
  if (typeof schema !== "string" || !/^[a-z_][a-z0-9_]{0,62}$/.test(schema)) throw new Error("Invalid runtime schema");
  return runReadOnlyDepositAudit(pool, async client => {
    const result = await client.query(
`
      SELECT c.relname AS table_name, a.attname AS column_name,
        c.relkind='r' AND c.relpersistence='p' AS ordinary_permanent,
        NOT EXISTS (SELECT 1 FROM pg_catalog.pg_inherits i
          WHERE i.inhrelid=c.oid OR i.inhparent=c.oid) AS standalone_relation,
        NOT EXISTS (SELECT 1 FROM pg_catalog.pg_rewrite rw
          WHERE rw.ev_class=c.oid) AS rewrite_free,
        NOT c.relrowsecurity AND NOT c.relforcerowsecurity AND NOT EXISTS (
          SELECT 1 FROM pg_catalog.pg_policy p WHERE p.polrelid=c.oid
        ) AS reviewed_row_security,
        pg_catalog.to_regclass(pg_catalog.quote_ident(c.relname)) = c.oid AS resolves_expected,
        pg_catalog.has_schema_privilege(current_user, n.oid, 'USAGE') AS schema_usage,
        pg_catalog.has_table_privilege(current_user, c.oid, 'SELECT') AS can_select,
        pg_catalog.has_column_privilege(current_user, c.oid, a.attnum, 'INSERT') AS can_insert,
        pg_catalog.has_column_privilege(current_user, c.oid, a.attnum, 'UPDATE') AS can_update,
        pg_catalog.pg_has_role(current_user, c.relowner, 'MEMBER') AS owner_access,
        pg_catalog.has_table_privilege(current_user, c.oid, 'TRUNCATE, TRIGGER, DELETE') AS destructive_access,
        pg_catalog.has_column_privilege(current_user, c.oid, a.attnum, 'INSERT WITH GRANT OPTION, UPDATE WITH GRANT OPTION') AS write_grant_option
      FROM pg_catalog.pg_class c
      JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      JOIN pg_catalog.pg_attribute a ON a.attrelid = c.oid
      WHERE n.nspname = $1 AND c.relkind IN ('r','p')
        AND c.relname = ANY($2::text[]) AND a.attnum > 0 AND NOT a.attisdropped
    `, [schema,Object.keys(required)]);
    if (!Array.isArray(result?.rows)) throw new Error("Runtime schema inspection failed");
    for (const [table, columns] of Object.entries(required)) {
      for (const column of columns) {
        const matching = result.rows.filter(row => row.table_name === table && row.column_name === column);
        if (matching.length !== 1) throw new Error("Required runtime schema object missing");
        const row = matching[0];
        // The reviewed non-financial runtime has no row filtering contract.
        // Reject a different topology or any unreviewed policy, even dormant.
        if (row.ordinary_permanent !== true || row.standalone_relation !== true ||
            row.rewrite_free !== true || row.reviewed_row_security !== true) {
          throw new Error("Runtime relation topology or row security incompatible");
        }
        if (row.resolves_expected !== true || row.schema_usage !== true || row.can_select !== true) {
          throw new Error("Runtime schema access or resolution mismatch");
        }
      }
    }
    // Include extra columns too: a table-level write grant must not pass
    // just because the additional columns are absent from our inventory.
    for (const row of result.rows) {
      const expectedInsert = insertColumns[row.table_name]?.includes(row.column_name) === true;
      const expectedUpdate = updateColumns[row.table_name]?.includes(row.column_name) === true;
      if (row.owner_access !== false || row.destructive_access !== false || row.write_grant_option !== false ||
          (!expectedInsert && row.can_insert !== false) || (!expectedUpdate && row.can_update !== false)) {
        throw new Error("Runtime role has excessive operational or ledger access");
      }
      if ((expectedInsert && row.can_insert !== true) || (expectedUpdate && row.can_update !== true)) {
        throw new Error("Runtime schema access or resolution mismatch");
      }
    }
    const sequences = await client.query(`
      SELECT c.relname AS table_name, a.attidentity, d.deptype,
        sn.nspname AS sequence_schema,
        s.relpersistence='p' AND q.seqincrement=1 AND NOT q.seqcycle
          AND q.seqmin>=1 AND q.seqstart>=q.seqmin AS reviewed_sequence_policy,
        pg_catalog.pg_get_expr(ad.adbin,ad.adrelid) =
          pg_catalog.format('nextval(%L::regclass)',s.oid::regclass::text) AS serial_default,
        pg_catalog.has_sequence_privilege(current_user,s.oid,'USAGE') AS can_use,
        pg_catalog.has_sequence_privilege(current_user,s.oid,'UPDATE, USAGE WITH GRANT OPTION') AS excessive_access,
        pg_catalog.pg_has_role(current_user,s.relowner,'MEMBER') AS owner_access
      FROM pg_catalog.pg_class c
      JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
      JOIN pg_catalog.pg_attribute a ON a.attrelid=c.oid AND a.attname='id'
      JOIN pg_catalog.pg_depend d ON d.refclassid='pg_catalog.pg_class'::regclass AND d.refobjid=c.oid
        AND d.refobjsubid=a.attnum AND d.classid='pg_catalog.pg_class'::regclass AND d.deptype IN ('a','i')
      JOIN pg_catalog.pg_class s ON s.oid=d.objid AND s.relkind='S'
      JOIN pg_catalog.pg_namespace sn ON sn.oid=s.relnamespace
      JOIN pg_catalog.pg_sequence q ON q.seqrelid=s.oid
      LEFT JOIN pg_catalog.pg_attrdef ad ON ad.adrelid=c.oid AND ad.adnum=a.attnum
      WHERE n.nspname=$1 AND c.relname=ANY($2::text[])
    `, [schema,generatedIdTables]);
    for (const table of generatedIdTables) {
      const matches = sequences.rows?.filter(row=>row.table_name===table);
      const row = matches?.[0];
      const identity = ["a","d"].includes(row?.attidentity) && row.deptype==="i";
      const serial = row?.attidentity==="" && row.deptype==="a" && row.serial_default===true && row.can_use===true;
      if (matches?.length!==1 || row.sequence_schema!==schema || (!identity && !serial) ||
          row.reviewed_sequence_policy!==true || row.owner_access!==false || row.excessive_access!==false) {
        throw new Error("Runtime generated ID sequence missing or incompatible");
      }
    }
    const privileges = await client.query(
      `SELECT current_user = session_user AS same_session_role,
        pg_catalog.current_schemas(true)::text[] = ARRAY['pg_catalog'::text,$1::text] AS reviewed_search_path,
        pg_catalog.current_setting('session_replication_role') = 'origin' AS origin_replication_role,
        pg_catalog.has_parameter_privilege(current_user,'session_replication_role','SET') AS replication_role_set,
        EXISTS (SELECT 1 FROM pg_catalog.pg_roles r
          WHERE r.rolname <> current_user AND pg_catalog.pg_has_role(current_user,r.oid,'MEMBER')) AS alternate_role,
        pg_catalog.has_schema_privilege(current_user, n.oid, 'CREATE') AS schema_create,
        pg_catalog.has_database_privilege(current_user, current_database(), 'CREATE') AS database_create,
        EXISTS (SELECT 1 FROM pg_catalog.pg_roles r
          WHERE pg_catalog.pg_has_role(current_user, r.oid, 'MEMBER')
          AND (r.rolsuper OR r.rolcreaterole OR r.rolcreatedb OR r.rolreplication OR r.rolbypassrls
            OR r.rolname IN ('pg_write_all_data','pg_execute_server_program','pg_write_server_files','pg_read_server_files'))) AS privileged_role
       FROM pg_catalog.pg_namespace n WHERE n.nspname = $1`, [schema]);
    const role = privileges.rows?.[0];
    if (privileges.rows?.length !== 1 || role?.same_session_role !== true || role.alternate_role !== false ||
        role.schema_create !== false ||
        role.database_create !== false || role.privileged_role !== false ||
        role.reviewed_search_path !== true || role.origin_replication_role !== true || role.replication_role_set !== false) {
      throw new Error("Runtime role has excessive database privileges");
    }
    // Pre-financial runtime: deny writes to any other persistent relation
    // in the application schema, including tables not yet in the inventory.
    const extraAccess = await client.query(`
      SELECT EXISTS (
        SELECT 1 FROM pg_catalog.pg_class c
        JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname=$1 AND c.relkind IN ('r','p','v','m','f')
          AND NOT (c.relname=ANY($2::text[]))
          AND (pg_catalog.pg_has_role(current_user,c.relowner,'MEMBER')
            OR pg_catalog.has_any_column_privilege(current_user,c.oid,'INSERT, UPDATE')
            OR pg_catalog.has_table_privilege(current_user,c.oid,'INSERT, UPDATE, DELETE, TRUNCATE, TRIGGER'))
      ) AS unexpected_relation_access,
      EXISTS (
        SELECT 1 FROM pg_catalog.pg_proc p
        JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
        WHERE n.nspname=$1 AND p.prosecdef
          AND NOT (p.proname='profino_lock_active_owner' AND p.pronargs=0 AND p.prokind='f')
          AND (pg_catalog.has_function_privilege(current_user,p.oid,'EXECUTE')
            OR pg_catalog.pg_has_role(current_user,p.proowner,'MEMBER'))
      ) AS unexpected_definer_access
    `, [schema,Object.keys(required)]);
    if (extraAccess.rows?.length !== 1 ||
        extraAccess.rows[0]?.unexpected_relation_access !== false ||
        extraAccess.rows[0]?.unexpected_definer_access !== false) {
      throw new Error("Runtime role has unreviewed application object access");
    }
    const trigger = await client.query(
`
      SELECT t.tgname, t.tgenabled, t.tgtype::int AS trigger_type, p.proname, fn.nspname AS function_schema,
        t.tgqual IS NULL AS unconditional, t.tgnargs = 0 AS no_arguments,
        p.prosrc AS function_body, p.prosecdef, p.prokind, p.provolatile,
        p.pronargs AS function_arguments, p.proconfig, l.lanname,
        p.prorettype = 'pg_catalog.trigger'::regtype AS trigger_result,
        pg_catalog.pg_has_role(current_user,p.proowner,'MEMBER') AS function_owned
      FROM pg_catalog.pg_trigger t
      JOIN pg_catalog.pg_class c ON c.oid = t.tgrelid
      JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      JOIN pg_catalog.pg_proc p ON p.oid = t.tgfoid
      JOIN pg_catalog.pg_namespace fn ON fn.oid = p.pronamespace
      JOIN pg_catalog.pg_language l ON l.oid = p.prolang
      WHERE n.nspname = $1 AND c.relname = 'scheduled_posts'
        AND NOT t.tgisinternal
    `, [schema]);
    const row = trigger.rows?.[0];
    // The history trigger is the only reviewed noninternal scheduled-post
    // trigger. Extra triggers can change an approved publication or suppress
    // history; even disabled triggers are unreviewed catalog configuration.
    if (trigger.rows?.length !== 1 || row?.tgname !== "trg_scheduled_post_history" ||
        !["O","A"].includes(row?.tgenabled) ||
        row.trigger_type !== 21 || row.proname !== "profino_log_scheduled_post_history" ||
        row.function_schema !== schema || row.unconditional !== true || row.no_arguments !== true ||
        typeof row.function_body !== "string" || row.function_body.trim() !== postHistoryTriggerBody.trim() ||
        row.prosecdef !== false || row.prokind !== "f" || row.provolatile !== "v" || row.function_arguments !== 0 ||
        row.proconfig !== null || row.lanname !== "plpgsql" || row.trigger_result !== true || row.function_owned !== false) {
      throw new Error("Required post history trigger missing or incompatible");
    }
    await verifyActiveOwnerLock(client, schema);
    return Object.freeze({ operationalInventoryVerified: true, financialActivationReady: false });
  });
}

export async function prepareRuntimeSchema({pool, ensurePostHistorySchema, ensureAdminOpsSchema,
  isStopping = () => false, env = process.env}) {
  const mode = runtimeSchemaMode(env);
  if (isStopping()) return;
  if (mode === "verify-only") return verifyRuntimeSchema(pool);
  await ensurePostHistorySchema();
  if (!isStopping()) await ensureAdminOpsSchema();
}
