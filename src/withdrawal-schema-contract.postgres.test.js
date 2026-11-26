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

test("withdrawal schema rejects invalid state combinations and duplicate identities in PostgreSQL",{skip:!enabled},async()=>{
  const client=await pool.connect();
  try{
    await client.query("BEGIN");
    await client.query("INSERT INTO users(id) VALUES(1),(2)");
    const {rows:accounts}=await client.query(`INSERT INTO ledger_accounts(user_id,account_code,account_type) VALUES
      (1,'schema-contract-available','AVAILABLE'),(1,'schema-contract-held','WITHDRAWAL_HOLD'),
      (NULL,'schema-contract-clearing','CLEARING') RETURNING id,account_type`);
    const a=Object.fromEntries(accounts.map(x=>[x.account_type,x.id]));
    const {rows:[journal]}=await client.query("INSERT INTO ledger_transactions(transaction_type,idempotency_key) VALUES('test-contract','schema-contract-journal') RETURNING id");
    let sequence=0;
    const insert=(status,hash,event,payout,clearing,key="case-"+(++sequence),amount="1")=>client.query(
      `INSERT INTO simulation_withdrawals(user_id,request_key,amount,available_id,held_id,status,submitted_hash,payout_event,payout_id,clearing_id)
       VALUES(1,$1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
      [key,amount,a.AVAILABLE,a.WITHDRAWAL_HOLD,status,hash,event,payout,clearing]);
    async function rejects(code,fn){
      await client.query("SAVEPOINT invalid_case");
      try{await assert.rejects(fn(),e=>e.code===code);}
      finally{await client.query("ROLLBACK TO SAVEPOINT invalid_case");await client.query("RELEASE SAVEPOINT invalid_case");}
    }
    const hash="0x"+"1".repeat(64),event="97:"+hash+":0";
    for(const args of [
      ["unknown",null,null,null,null],
      ["reserved",hash,null,null,null],
      ["cancelled",hash,null,null,null],
      ["pending_receipt",null,null,null,null],
      ["pending_receipt",hash,event,null,null],
      ["paid",null,event,journal.id,a.CLEARING],
      ["paid",hash,null,journal.id,a.CLEARING],
      ["paid",hash,event,null,a.CLEARING],
      ["paid",hash,event,journal.id,null],
      ["reserved",null,null,journal.id,null],
      ["cancelled",null,null,null,a.CLEARING]
    ]) await rejects("23514",()=>insert(...args));
    await rejects("23514",()=>insert("reserved",null,null,null,null,"zero","0"));
    await rejects("23514",()=>insert("reserved",null,null,null,null,"negative","-1"));
    await insert("reserved",null,null,null,null,"reserved");
    await insert("cancelled",null,null,null,null,"cancelled");
    await insert("pending_receipt","0x"+"2".repeat(64),null,null,null,"pending");
    await insert("paid",hash,event,journal.id,a.CLEARING,"paid");
    await rejects("23505",()=>insert("reserved",null,null,null,null,"reserved"));
    await rejects("23505",()=>insert("pending_receipt",hash,null,null,null,"duplicate-hash"));
    const {rows:[second]}=await client.query("INSERT INTO ledger_transactions(transaction_type,idempotency_key) VALUES('test-contract','schema-contract-second') RETURNING id");
    await rejects("23505",()=>insert("paid","0x"+"3".repeat(64),event,second.id,a.CLEARING));
    await rejects("23505",()=>insert("paid","0x"+"4".repeat(64),"97:other:0",journal.id,a.CLEARING));
    await rejects("23503",()=>insert("paid","0x"+"5".repeat(64),"97:missing:0","9223372036854775807",a.CLEARING));
    const {rows:[total]}=await client.query("SELECT count(*)::int AS n FROM simulation_withdrawals");
    assert.equal(total.n,4);
    // Base fixture constraints are structural only; state-history, owner links,
    // payload and posted journal identity need the separately reviewed guards.
  }finally{await client.query("ROLLBACK");client.release();}
});

test("staging preflight rejects permissive or unvalidated withdrawal state constraints",{skip:!enabled},async()=>{
  const {inspectStagingWithdrawalSchema}=await import("./staging-simulation.js");
  const client=await pool.connect();
  try{
    await client.query("BEGIN");
    assert.deepEqual(await inspectStagingWithdrawalSchema(client),{extended_columns:true,payout_state_constraint:true});
    await client.query("ALTER TABLE simulation_withdrawals DROP CONSTRAINT simulation_withdrawals_status_check");
    await client.query("ALTER TABLE simulation_withdrawals ADD CONSTRAINT fake_state CHECK (status IN ('reserved','cancelled','pending_receipt','paid') OR true)");
    assert.equal((await inspectStagingWithdrawalSchema(client)).payout_state_constraint,false);
    await client.query("ALTER TABLE simulation_withdrawals DROP CONSTRAINT fake_state");
    await client.query("ALTER TABLE simulation_withdrawals ADD CONSTRAINT reviewed_state CHECK (status IN ('reserved','cancelled','pending_receipt','paid')) NOT VALID");
    assert.equal((await inspectStagingWithdrawalSchema(client)).payout_state_constraint,false);
    await client.query("ALTER TABLE simulation_withdrawals VALIDATE CONSTRAINT reviewed_state");
    assert.equal((await inspectStagingWithdrawalSchema(client)).payout_state_constraint,true);
    await client.query("ALTER TABLE simulation_withdrawals ALTER COLUMN status DROP NOT NULL");
    assert.equal((await inspectStagingWithdrawalSchema(client)).extended_columns,false);
  }finally{await client.query("ROLLBACK");client.release();}
});
