import { isDisposablePostgresTarget } from "../test-support/disposable-postgres-target.js";
import test from "node:test";
import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";
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

test("access audit detects column-level, PUBLIC and delegable ledger privileges",{skip:!safeTarget()},async()=>{
 const suffix=randomUUID().replaceAll("-","");
 const schema="access_"+suffix, role="role_"+suffix;
 const pool=new pg.Pool({connectionString:url,max:1});
 const inspect=()=>runReadOnlyDepositAudit(pool,client=>inspectDatabaseAccess(client,{schema}));
 try{
  await pool.query('CREATE SCHEMA "'+schema+'"');
  await pool.query('CREATE ROLE "'+role+'" NOLOGIN');
  for(const table of ["ledger_accounts","ledger_transactions","ledger_entries"]){
   await pool.query('CREATE TABLE "'+schema+'".'+table+'(id bigint, amount numeric)');
  }
  await pool.query('GRANT USAGE ON SCHEMA "'+schema+'" TO "'+role+'"');
  await pool.query('GRANT SELECT ON ALL TABLES IN SCHEMA "'+schema+'" TO "'+role+'"');
  await pool.query('SET ROLE "'+role+'"');
  const clean=await inspect();
  assert.equal(clean.session_role_matches,false);
  assert.equal(clean.privileged_role_membership,false);
  assert.equal(clean.can_set_replication_role,false);
  assert.equal(clean.replication_role_origin,true);
  assert.equal(clean.ledger_tables_present,3);
  for(const field of ["ledger_tables_owned","ledger_tables_insertable","ledger_tables_updatable","ledger_tables_deletable","ledger_tables_delegable","ledger_tables_public_write"])assert.equal(clean[field],0);
  await pool.query("RESET ROLE");
  await pool.query('GRANT UPDATE(amount) ON "'+schema+'".ledger_entries TO "'+role+'" WITH GRANT OPTION');
  await pool.query('GRANT INSERT(amount) ON "'+schema+'".ledger_accounts TO PUBLIC');
  await pool.query('GRANT DELETE ON "'+schema+'".ledger_transactions TO "'+role+'"');
  await pool.query('ALTER TABLE "'+schema+'".ledger_accounts ENABLE ROW LEVEL SECURITY');
  await pool.query('ALTER TABLE "'+schema+'".ledger_accounts FORCE ROW LEVEL SECURITY');
  await pool.query('CREATE POLICY public_fixture ON "'+schema+'".ledger_accounts FOR INSERT TO PUBLIC WITH CHECK (true)');
  await pool.query('CREATE POLICY read_fixture ON "'+schema+'".ledger_entries FOR SELECT TO "'+role+'" USING (true)');
  const ownerEvidence=await inspect();
  assert.equal(ownerEvidence.ledger_tables_rls_enabled,1);
  assert.equal(ownerEvidence.ledger_tables_rls_forced,1);
  assert.equal(ownerEvidence.ledger_tables_rls_active,0);
  assert.equal(ownerEvidence.ledger_tables_with_policies,2);
  assert.equal(ownerEvidence.ledger_tables_public_write_policy,1);
  await pool.query('GRANT SET ON PARAMETER session_replication_role TO "'+role+'"');
  await pool.query('SET ROLE "'+role+'"');
  const excess=await inspect();
  assert.equal(excess.ledger_tables_updatable,1);
  assert.equal(excess.ledger_tables_insertable,1);
  assert.equal(excess.ledger_tables_deletable,1);
  assert.equal(excess.ledger_tables_delegable,1);
  assert.equal(excess.ledger_tables_public_write,1);
  assert.equal(excess.ledger_tables_rls_enabled,1);
  assert.equal(excess.ledger_tables_rls_forced,1);
  assert.equal(excess.ledger_tables_rls_active,1);
  assert.equal(excess.ledger_tables_with_policies,2);
  assert.equal(excess.ledger_tables_public_write_policy,1);
  assert.equal(excess.can_set_replication_role,true);
  assert.equal(JSON.stringify(excess).includes(role),false);
  assert.equal(JSON.stringify(excess).includes(schema),false);
  assert.equal(JSON.stringify(excess).includes("public_fixture"),false);
  await pool.query("RESET ROLE");
  await pool.query('DROP POLICY public_fixture ON "'+schema+'".ledger_accounts');
  await pool.query('ALTER TABLE "'+schema+'".ledger_accounts DISABLE ROW LEVEL SECURITY');
  const after=await inspect();
  assert.equal(after.ledger_tables_rls_enabled,0);
  assert.equal(after.ledger_tables_rls_active,0);
  assert.equal(after.ledger_tables_rls_forced,0);
  assert.equal(after.ledger_tables_with_policies,1);
  assert.equal(after.ledger_tables_public_write_policy,0);
 }finally{
  try{
   await pool.query("RESET ROLE");
   await pool.query('DROP SCHEMA IF EXISTS "'+schema+'" CASCADE');
   await pool.query('REVOKE SET ON PARAMETER session_replication_role FROM "'+role+'"');
   await pool.query('DROP ROLE IF EXISTS "'+role+'"');
  }finally{await pool.end();}
 }
});

test("access audit distinguishes session role paths, callable privileged routines and ledger function ownership",{skip:!safeTarget()},async()=>{
 const suffix=randomUUID().replaceAll("-","");
 const schema="paths_"+suffix, login="login_"+suffix, owner="owner_"+suffix;
 const pool=new pg.Pool({connectionString:url,max:1});
 const inspect=()=>runReadOnlyDepositAudit(pool,client=>inspectDatabaseAccess(client,{schema}));
 try{
  await pool.query('CREATE SCHEMA "'+schema+'"');
  await pool.query('CREATE ROLE "'+login+'" NOLOGIN');
  await pool.query('CREATE ROLE "'+owner+'" NOLOGIN');
  await pool.query('GRANT USAGE ON SCHEMA "'+schema+'" TO "'+login+'"');
  await pool.query('GRANT USAGE,CREATE ON SCHEMA "'+schema+'" TO "'+owner+'"');
  await pool.query('CREATE TABLE "'+schema+'".ledger_accounts(id bigint)');
  await pool.query('ALTER TABLE "'+schema+'".ledger_accounts OWNER TO "'+owner+'"');
  await pool.query('CREATE FUNCTION "'+schema+'".validate_posted_transaction(bigint) RETURNS void LANGUAGE plpgsql AS \'BEGIN RETURN; END;\'');
  await pool.query('ALTER FUNCTION "'+schema+'".validate_posted_transaction(bigint) OWNER TO "'+owner+'"');
  await pool.query('CREATE FUNCTION "'+schema+'".privileged_fixture() RETURNS integer LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog AS \'SELECT 1\'');
  await pool.query('SET SESSION AUTHORIZATION "'+login+'"');
  const before=await inspect();
  assert.equal(before.session_role_matches,true);
  assert.equal(before.session_can_assume_other_role,false);
  assert.equal(before.session_can_assume_ledger_function_owner,false);
  assert.equal(before.ledger_tables_session_owner_access,0);
  assert.equal(before.ledger_functions_public_execute,true);
  assert.equal(before.schema_callable_security_definer,true);
  await pool.query("RESET SESSION AUTHORIZATION");
  await pool.query('REVOKE EXECUTE ON FUNCTION "'+schema+'".privileged_fixture() FROM PUBLIC');
  await pool.query('REVOKE EXECUTE ON FUNCTION "'+schema+'".validate_posted_transaction(bigint) FROM PUBLIC');
  await pool.query('GRANT "'+owner+'" TO "'+login+'" WITH INHERIT FALSE');
  await pool.query('SET SESSION AUTHORIZATION "'+login+'"');
  const after=await inspect();
  assert.equal(after.session_can_assume_other_role,true);
  assert.equal(after.session_can_assume_ledger_function_owner,true);
  assert.equal(after.ledger_tables_session_owner_access,1);
  assert.equal(after.ledger_functions_public_execute,false);
  assert.equal(after.schema_callable_security_definer,false);
  assert.equal(JSON.stringify(after).includes(owner),false);
  assert.equal(JSON.stringify(after).includes(login),false);
 }finally{
  try{
   await pool.query("RESET SESSION AUTHORIZATION");
   await pool.query('DROP SCHEMA IF EXISTS "'+schema+'" CASCADE');
   await pool.query('DROP ROLE IF EXISTS "'+login+'"');
   await pool.query('DROP ROLE IF EXISTS "'+owner+'"');
  }finally{await pool.end();}
 }
});
