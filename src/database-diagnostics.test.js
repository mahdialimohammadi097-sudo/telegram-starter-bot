import test from "node:test";
import assert from "node:assert/strict";
import { formatCoreSchema } from "./database-diagnostics.js";

test("formats existing core tables with columns and constraints", () => {
  const messages = formatCoreSchema({
    expectedTables: ["users"],
    existingTables: ["users"],
    columns: [
      { table_name: "users", column_name: "telegram_id", data_type: "bigint", is_nullable: "NO", column_default: null }
    ],
    constraints: [
      { table_name: "users", constraint_name: "users_pkey", constraint_type: "p", definition: "PRIMARY KEY (id)" }
    ]
  });
  assert.match(messages[0], /telegram_id \| bigint \| nullable: NO/);
  assert.match(messages[0], /users_pkey \| p \| PRIMARY KEY/);
});

test("clearly reports expected tables missing from the live schema", () => {
  const messages = formatCoreSchema({
    expectedTables: ["ledger_entries"],
    existingTables: [],
    columns: [],
    constraints: []
  });
  assert.equal(messages[0], "TABLE: ledger_entries\nNOT FOUND");
});
