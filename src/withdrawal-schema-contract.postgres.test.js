import { isDisposablePostgresTarget } from "../test-support/disposable-postgres-target.js";
import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import pg from "pg";
import { createSimulationWithdrawalTables } from "../test-support/withdrawal-schema.js";

// These integration tests create and DROP PostgreSQL schemas. Never run them
// against a production or shared database, even when DATABASE_URL is present.
function isDisposableDatabase() {
  return isDisposablePostgresTarget(process.env.DATABASE_URL, "profino_test");
}
const enabled = isDisposableDatabase();
let admin, pool, schema;
before(async () => {
  if (!enabled) return;
  admin = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  schema = "profino_schema_contract_" + randomUUID().replaceAll("-", "");
  await admin.query('CREATE SCHEMA "' + schema + '"');
  pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, options: "-c search_path=" + schema });
  await pool.query(await readFile(new URL("../test/fixtures/ledger-contract.sql", import.meta.url), "utf8"));
  await createSimulationWithdrawalTables(pool);
});
after(async () => {
  if (pool) await pool.end();
  if (admin) {
    if (schema) await admin.query('DROP SCHEMA IF EXISTS "' + schema + '" CASCADE');
    await admin.end();
  }
});

test("PostgreSQL enforces four-state withdrawal and payout consistency", { skip: !enabled }, async () => {
  const { rows } = await pool.query(`
    SELECT pg_get_constraintdef(oid) AS definition
    FROM pg_constraint
    WHERE conrelid = 'simulation_withdrawals'::regclass AND contype = 'c'
  `);
  const definitions = rows.map(r => r.definition).join("\n");
  for (const status of ["reserved", "cancelled", "pending_receipt", "paid"]) {
    assert.ok(definitions.includes(status), "missing status: " + status);
  }
  assert.match(definitions, /submitted_hash/);
  for (const column of ["payout_event", "payout_id", "clearing_id"]) {
    assert.ok(definitions.includes(column), "missing payout constraint: " + column);
  }
  const { rows: indexes } = await pool.query(`
    SELECT indexdef FROM pg_indexes
    WHERE schemaname = current_schema() AND tablename = 'simulation_withdrawals'
  `);
  const allIndexes = indexes.map(r => r.indexdef).join("\n");
  assert.match(allIndexes, /\(user_id, request_key\)/);
  assert.match(allIndexes, /\(submitted_hash\)/);
  assert.match(allIndexes, /\(payout_event\)/);
});
