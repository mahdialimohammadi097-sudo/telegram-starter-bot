import { runReadOnlyDepositAudit } from "./read-only-deposit-audit.js";

// The existing production startup contract is retained during transition.
// Restricted deployments must opt into verify-only after reviewed preparation.
// This check covers operational admin/post objects, NOT financial readiness.
const required = Object.freeze({
  users: ["id", "telegram_id", "status"],
  scheduled_posts: ["id", "title", "content", "status", "scheduled_at", "updated_at", "created_at", "preview_message_id", "preview_chat_id", "approved_by", "published_message_id", "published_at", "cancelled_at", "cancellation_reason", "edit_version", "last_edited_at"],
  scheduled_post_history: ["id", "post_id", "event_type", "old_status", "new_status", "details", "changed_at"],
  admin_users: ["user_id", "role", "status"],
  admin_preferences: ["user_id", "language", "updated_at"],
  admin_audit_logs: ["id", "admin_user_id", "actor_telegram_id", "action", "target_user_id", "currency", "metadata", "details", "created_at"]
});
const writeTables = ["users","scheduled_posts","admin_preferences"];
const insertTables = ["users","scheduled_posts","scheduled_post_history","admin_preferences","admin_audit_logs"];

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
        pg_catalog.to_regclass(pg_catalog.quote_ident(c.relname)) = c.oid AS resolves_expected,
        pg_catalog.has_schema_privilege(current_user, n.oid, 'USAGE') AS schema_usage,
        pg_catalog.has_table_privilege(current_user, c.oid, 'SELECT') AS can_select,
        pg_catalog.has_table_privilege(current_user, c.oid, 'INSERT') AS can_insert,
        pg_catalog.has_table_privilege(current_user, c.oid, 'UPDATE') AS can_update
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
        if (row.resolves_expected !== true || row.schema_usage !== true || row.can_select !== true ||
            (insertTables.includes(table) && row.can_insert !== true) ||
            (writeTables.includes(table) && row.can_update !== true)) {
          throw new Error("Runtime schema access or resolution mismatch");
        }
      }
    }
    const trigger = await client.query(
`
      SELECT t.tgenabled, t.tgtype::int AS trigger_type, p.proname, fn.nspname AS function_schema,
        t.tgqual IS NULL AS unconditional, t.tgnargs = 0 AS no_arguments
      FROM pg_catalog.pg_trigger t
      JOIN pg_catalog.pg_class c ON c.oid = t.tgrelid
      JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      JOIN pg_catalog.pg_proc p ON p.oid = t.tgfoid
      JOIN pg_catalog.pg_namespace fn ON fn.oid = p.pronamespace
      WHERE n.nspname = $1 AND c.relname = 'scheduled_posts'
        AND t.tgname = 'trg_scheduled_post_history' AND NOT t.tgisinternal
    `, [schema]);
    const row = trigger.rows?.[0];
    if (trigger.rows?.length !== 1 || !["O","A"].includes(row?.tgenabled) ||
        row.trigger_type !== 21 || row.proname !== "profino_log_scheduled_post_history" ||
        row.function_schema !== schema || row.unconditional !== true || row.no_arguments !== true) {
      throw new Error("Required post history trigger missing or incompatible");
    }
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
