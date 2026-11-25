import test from "node:test";
import assert from "node:assert/strict";
import { formatCoreSchema, inspectCoreSchema } from "./database-diagnostics.js";

function diagnosticPool(query, calls=[], releases=[]){
  return {async connect(){return {async query(sql,params){
    calls.push(sql);
    if(sql.startsWith("BEGIN "))return {command:"BEGIN"};
    if(sql.startsWith("SET LOCAL "))return {command:"SET"};
    if(sql.includes("pg_catalog.current_setting('transaction_read_only')")){
      return {rows:[{read_only:"on",isolation:"repeatable read",statement_timeout:"10s",lock_timeout:"3s"}]};
    }
    if(sql==="COMMIT"||sql==="ROLLBACK")return {command:sql};
    return query(sql,params);
  },release(error){releases.push(error);}};}};
}

test("formats existing core tables with columns and constraints", () => {
  const messages = formatCoreSchema({
    expectedTables: ["users"],
    tableInventory: ["users"],
    existingTables: ["users"],
    indexes: [],
    triggers: [],
    columns: [
      { table_name: "users", column_name: "telegram_id", data_type: "bigint", is_nullable: "NO", column_default: null }
    ],
    constraints: [
      { table_name: "users", constraint_name: "users_pkey", constraint_type: "p", definition: "PRIMARY KEY (id)" }
    ]
  });
  assert.ok(messages.some(message => message.includes("telegram_id | bigint | nullable: NO")));
  assert.ok(messages.some(message => message.includes("users_pkey | p | PRIMARY KEY")));
});

test("clearly reports expected tables missing from the live schema", () => {
  const messages = formatCoreSchema({
    expectedTables: ["ledger_entries"],
    tableInventory: [],
    existingTables: [],
    indexes: [],
    triggers: [],
    columns: [],
    constraints: []
  });
  assert.ok(messages.some(message => message === "TABLE: ledger_entries\nNOT FOUND"));
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
  assert.ok(messages.some(message => message.includes("users, profit_records")));
  assert.ok(messages.some(message => message.includes("DATABASE INDEXES") && message.includes("users_pkey")));
  assert.ok(messages.some(message => message.includes("DATABASE TRIGGERS") && message.includes("check_ledger_balance")));
});


test("reports numeric precision, deferred constraints, and trigger enabled state", () => {
  const messages = formatCoreSchema({
    expectedTables: ["ledger_entries"],
    tableInventory: ["ledger_entries"],
    existingTables: ["ledger_entries"],
    columns: [{
      table_name: "ledger_entries",
      column_name: "amount",
      data_type: "numeric",
      udt_name: "numeric",
      is_nullable: "NO",
      column_default: null,
      numeric_precision: 30,
      numeric_scale: 8,
      is_identity: "NO",
      is_generated: "NEVER"
    }],
    constraints: [{
      table_name: "ledger_entries",
      constraint_name: "ledger_balance_check",
      constraint_type: "c",
      definition: "CHECK (amount > 0)",
      is_deferrable: true,
      initially_deferred: true,
      is_validated: true,
      no_inherit: false
    }],
    indexes: [],
    triggers: [{
      table_name: "ledger_entries",
      trigger_name: "ledger_balance_guard",
      enabled_state: "O",
      is_deferrable: true,
      initially_deferred: true,
      trigger_definition: "CREATE CONSTRAINT TRIGGER ledger_balance_guard DEFERRABLE INITIALLY DEFERRED",
      function_name: "check_ledger_balance",
      function_definition: "CREATE FUNCTION check_ledger_balance() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END; $$"
    }]
  });

  assert.ok(messages.some(message => message.includes("amount | numeric | nullable: NO | precision: 30 | scale: 8")));
  assert.ok(messages.some(message => message.includes("deferrable: YES | initially deferred: YES | validated: YES")));
  assert.ok(messages.some(message => message.includes("enabled state: O | deferrable: YES | initially deferred: YES")));
});

test("inspection includes the delegated ledger validator without executing it", async () => {
  const definition = "CREATE FUNCTION validate_posted_transaction(bigint) RETURNS void LANGUAGE plpgsql AS $$ BEGIN RETURN; END; $$";
  const statements = [];
  const snapshot = await inspectCoreSchema(diagnosticPool(async sql => {
      if (sql.includes("p.proname = 'validate_posted_transaction'")) {
        return { rows: [{ function_name: "validate_posted_transaction", arguments: "p_transaction_id bigint", function_definition: definition }] };
      }
      return { rows: [] };
  }, statements));
  assert.match(statements[0], /BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY/);
  assert.equal(statements.at(-1), "COMMIT");
  assert.ok(statements.slice(3,-1).every(sql => /^SELECT\b/.test(sql.trim())));
  assert.ok(formatCoreSchema(snapshot).some(section =>
    section.includes("LEDGER VALIDATION FUNCTIONS") && section.includes(definition)));
});

test("reports a missing delegated validator explicitly", async () => {
  const snapshot = await inspectCoreSchema(diagnosticPool(async()=>({rows:[]})));
  assert.ok(formatCoreSchema(snapshot).some(section =>
    section.includes("validate_posted_transaction: NOT FOUND")));
});

test("core diagnostics rollback and release after an inspection failure",async()=>{
  const calls=[],releases=[];
  const original=new Error("synthetic catalog error");
  await assert.rejects(inspectCoreSchema(diagnosticPool(async()=>{throw original;},calls,releases)),error=>error===original);
  assert.equal(calls.at(-1),"ROLLBACK");
  assert.deepEqual(releases,[undefined]);
  assert.ok(!calls.includes("COMMIT"));
});

test("core diagnostics never query metadata without confirmed read-only state",async()=>{
  let released=false;
  const calls=[];
  const pool={async connect(){return {async query(sql){
    calls.push(sql);
    if(sql.startsWith("BEGIN "))return {command:"BEGIN"};
    if(sql.startsWith("SET LOCAL "))return {command:"SET"};
    if(sql.includes("current_setting"))return {rows:[{read_only:"off",isolation:"repeatable read",statement_timeout:"10s",lock_timeout:"3s"}]};
    if(sql==="ROLLBACK")return {command:"ROLLBACK"};
    assert.fail("unexpected catalog query");
  },release(){released=true;}};}};
  await assert.rejects(inspectCoreSchema(pool),/settings incompatible/);
  assert.equal(calls.at(-1),"ROLLBACK");
  assert.equal(released,true);
});
