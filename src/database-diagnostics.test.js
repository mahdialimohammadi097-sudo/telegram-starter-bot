import test from "node:test";
import assert from "node:assert/strict";
import { formatCoreSchema } from "./database-diagnostics.js";

test("formats existing core tables with columns and constraints", () => {
  const messages = formatCoreSchema({
    expectedTables: ["users"],
    tableInventory: ["users"],
    indexes: [],
    triggers: [],
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
    tableInventory: [],
    indexes: [],
    triggers: [],
    existingTables: [],
    columns: [],
    constraints: []
  });
  assert.equal(messages[0], "TABLE: ledger_entries\nNOT FOUND");
});

test("includes the full table inventory and user-defined trigger definitions", () => {
  const messages = formatCoreSchema({
    expectedTables: ["users"],
    tableInventory: ["users", "profit_records"],
    existingTables: ["users"],
    columns: [],
    constraints: [],
    indexes: [{ table_name: "users", indexname: "users_pkey", indexdef: "CREATE UNIQUE INDEX users_pkey ON public.users USING btree (id)" }],
    triggers: [{
      table_name: "ledger_entries",
      trigger_name: "ledger_balance_guard",
      trigger_definition: "CREATE CONSTRAINT TRIGGER ledger_balance_guard AFTER INSERT ON ledger_entries DEFERRABLE INITIALLY DEFERRED",
      function_name: "check_ledger_balance",
      function_definition: "CREATE FUNCTION check_ledger_balance() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END; $$"
    }]
  });
  assert.match(messages[0], /users, profit_records/);
  assert.ok(messages.some(message => message.includes("DATABASE INDEXES") && message.includes("users_pkey")));
  assert.ok(messages.some(message => message.includes("DATABASE TRIGGERS") && message.includes("check_ledger_balance")));
});
