import { isDisposablePostgresTarget } from "../test-support/disposable-postgres-target.js";
import test from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { inspectDatabaseAccess } from "./database-access-audit.js";
import { runReadOnlyDepositAudit } from "./read-only-deposit-audit.js";
const url = process.env.CATALOG_REHEARSAL_URL;
function safeTarget() {
  return isDisposablePostgresTarget(url, "catalog_rehearsal");
}
test("PostgreSQL 17 returns bounded current-role evidence inside read-only snapshot", {skip:!safeTarget()}, async () => {
  const pool = new pg.Pool({connectionString:url,max:1});
  try {
    const result = await runReadOnlyDepositAudit(pool, inspectDatabaseAccess);
    assert.equal(result.read_only,true);
    assert.equal(result.server_major,17);
    assert.equal(typeof result.tls,"boolean");
    assert.equal(typeof result.privileged_role_membership,"boolean");
    assert.ok(result.ledger_tables_present>=0 && result.ledger_tables_present<=3);
    await assert.rejects(inspectDatabaseAccess(pool),/incomplete or unsafe/);
  } finally { await pool.end(); }
});

test("real PostgreSQL aborted read-only audit does not return a successful report", {skip:!safeTarget()}, async () => {
  const pool = new pg.Pool({connectionString:url,max:1});
  try {
    await assert.rejects(runReadOnlyDepositAudit(pool, async client => {
      await assert.rejects(client.query("SELECT 1 / 0"), e => e.code === "22012");
      return {ready:true};
    }), /did not commit/);
    assert.equal((await pool.query("SELECT 1 AS value")).rows[0].value,1);
  } finally { await pool.end(); }
});

test("PostgreSQL audit verifies effective settings and cannot write ordinary tables", {skip:!safeTarget()},async()=>{
 const pool=new pg.Pool({connectionString:url,max:1});
 try {
  const result=await runReadOnlyDepositAudit(pool,async client=>{
   const {rows:[state]}=await client.query(`SELECT pg_catalog.current_setting('transaction_read_only') AS read_only,
      pg_catalog.current_setting('transaction_isolation') AS isolation,
      pg_catalog.current_setting('statement_timeout') AS statement_timeout,
      pg_catalog.current_setting('lock_timeout') AS lock_timeout`);
   assert.deepEqual(state,{read_only:"on",isolation:"repeatable read",statement_timeout:"10s",lock_timeout:"3s"});
   return {verified:true};
  });
  assert.deepEqual(result,{verified:true});
  await assert.rejects(runReadOnlyDepositAudit(pool,async client=>{
   await client.query("CREATE TABLE forbidden_read_only_fixture(id integer)");
  }),error=>error.code==="25006");
  assert.equal((await pool.query("SELECT to_regclass('public.forbidden_read_only_fixture') AS name")).rows[0].name,null);
 }finally{await pool.end();}
});
