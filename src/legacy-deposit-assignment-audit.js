import { runCatalogReadOnlyDepositAudit } from "./read-only-deposit-audit.js";
import { auditDepositSchema } from "./deposit-schema-audit.js";
import { inspectHistoricalGuardInventory } from "./admin-schema-audit.js";

const predicates = new Set([
  "((status = 'active'::text) AND (assignment_type = 'deposit'::text))",
  "((assignment_type = 'deposit'::text) AND (status = 'active'::text))"
]);

// Separate operator audit, never invoked by the bot or by a posting path.
// The snapshot only proves the legacy active-assignment rule; historical
// ownership, on-chain proof, distinct addresses and production gates remain separate.
function validateSchema(schema) {
  if (typeof schema !== "string" || !/^[a-z_][a-z0-9_]{0,62}$/.test(schema)) {
    throw new TypeError("Invalid assignment audit schema");
  }
}

export async function auditLegacyDepositAssignments(pool, { schema = "public" } = {}) {
  validateSchema(schema);
  return runCatalogReadOnlyDepositAudit(pool, client => inspectLegacyAssignments(client, schema));
}

// All three inspections share one bounded read-only transaction.
export async function auditCombinedDepositPreflight(pool, { schema = "public" } = {}) {
  validateSchema(schema);
  return runCatalogReadOnlyDepositAudit(pool, async client => {
    const assignments = await inspectLegacyAssignments(client, schema);
    const catalog = await auditDepositSchema(client, { schema });
    const historicalBasicGuardsPresent = await inspectHistoricalGuardInventory(client, schema);
    return Object.freeze({
      ready: catalog.ready === true && assignments.ready === true && historicalBasicGuardsPresent,
      scope: "catalog-legacy-assignment-and-basic-historical-guards-only",
      historicalBasicGuardsPresent,
      catalog,
      assignments,
      realDepositsEnabled: false
    });
  });
}

async function inspectLegacyAssignments(client, schema) {
  // PostgreSQL row_security=off raises rather than silently filtering rows
  // when a policy applies to this audit role. It does not bypass RLS.
  const setting = await client.query("SET LOCAL row_security = off");
  const effective = await client.query("SELECT pg_catalog.current_setting('row_security') AS row_security");
  if (setting?.command !== "SET" || effective.rows?.length !== 1 ||
      effective.rows[0].row_security !== "off") {
    throw new Error("Assignment audit row visibility unconfirmed");
  }

  const table = await client.query(`
    SELECT t.oid::text AS relation_id,
           NOT EXISTS (
             SELECT 1 FROM pg_catalog.pg_inherits h
             WHERE h.inhparent=t.oid OR h.inhrelid=t.oid
           ) AS standalone,
           EXISTS (
             SELECT 1 FROM pg_catalog.pg_attribute a
             WHERE a.attrelid=t.oid AND a.attname='wallet_id'
               AND a.attnum>0 AND NOT a.attisdropped AND a.attnotnull
           ) AS wallet_not_null
    FROM pg_catalog.pg_class t
    JOIN pg_catalog.pg_namespace n ON n.oid=t.relnamespace
    WHERE n.nspname=$1 AND t.relname='user_wallet_assignments' AND t.relkind='r'
  `, [schema]);
  if (table.rows?.length !== 1 || table.rows[0].standalone !== true ||
      table.rows[0].wallet_not_null !== true) {
    throw new Error("Unsupported assignment relation or nullable wallet key");
  }

  // Never select wallet identifiers into application output. COUNT is text
  // to preserve bigint precision; no customer records are returned.
  const collisions = await client.query(`
    SELECT count(*)::text AS groups FROM (
      SELECT wallet_id FROM "${schema}".user_wallet_assignments
      WHERE status='active' AND assignment_type='deposit'
      GROUP BY wallet_id HAVING count(*)>1
    ) AS duplicate_groups
  `);
  const groups = collisions.rows?.[0]?.groups;
  if (collisions.rows?.length !== 1 || typeof groups !== "string" ||
      !/^(0|[1-9][0-9]*)$/.test(groups)) {
    throw new Error("Assignment collision count unavailable");
  }
  const indexes = await client.query(`
    SELECT i.indisunique, i.indisvalid, i.indisready, i.indislive,
           i.indimmediate, i.indisexclusion, i.indnkeyatts,
           i.indexprs IS NULL AS plain_columns, a.attname AS key_column,
           pg_catalog.pg_get_expr(i.indpred,i.indrelid,false) AS predicate
    FROM pg_catalog.pg_index i
    JOIN pg_catalog.pg_attribute a ON a.attrelid=i.indrelid AND a.attnum=i.indkey[0]
    WHERE i.indrelid=$1::oid
  `, [table.rows[0].relation_id]);
  const unique = indexes.rows.some(row =>
    row.indisunique === true && row.indisvalid === true && row.indisready === true &&
    row.indislive === true && row.indimmediate === true && row.indisexclusion === false &&
    row.plain_columns === true && Number(row.indnkeyatts) === 1 &&
    row.key_column === "wallet_id" && predicates.has(row.predicate));
  return Object.freeze({
    ready: groups === "0" && unique,
    conflictingActiveDepositWallets: groups,
    activeDepositWalletUniquenessEnforced: unique,
    realDepositsEnabled: false
  });
}
