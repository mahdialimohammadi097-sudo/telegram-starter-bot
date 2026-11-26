import test from "node:test";
import assert from "node:assert/strict";
import { inspectDatabaseAccess } from "./database-access-audit.js";
const fixture = { read_only:true, tls:false, server_major:17, privileged_role_membership:true,
 public_schema_create:true, ledger_tables_present:3, ledger_tables_owned:3,
 ledger_tables_truncatable:3, ledger_tables_trigger_privilege:3,
 session_role_matches:true, can_set_replication_role:true, replication_role_origin:true,
 ledger_tables_insertable:3,ledger_tables_updatable:3,ledger_tables_deletable:3,
 ledger_tables_rls_enabled:0,ledger_tables_delegable:3,ledger_tables_public_write:0,
 session_can_assume_other_role:true,schema_callable_security_definer:false,
 session_can_assume_ledger_function_owner:false,ledger_functions_public_execute:false,
 ledger_tables_session_owner_access:3 };
test("access audit returns only explicit role and transport evidence", async () => {
 const result = await inspectDatabaseAccess({query:async (sql,params) => {
   assert.match(sql,/pg_catalog.pg_stat_ssl/);
   assert.match(sql,/pg_has_role/);
   assert.match(sql,/has_any_column_privilege/);
   assert.match(sql,/aclexplode/);
   assert.deepEqual(params,["public"]);
   return {rows:[{...fixture, unexpected:"synthetic sensitive data"}]};
 }});
 assert.deepEqual(result, fixture);
 assert.ok(Object.isFrozen(result));
});
test("access audit rejects incomplete and non-read-only evidence",async()=>{
 for (const patch of [{read_only:false},{tls:null},{ledger_tables_present:0},{server_major:null},{ledger_tables_owned:4},{session_role_matches:null},{ledger_tables_public_write:-1},{ledger_tables_delegable:4},{schema_callable_security_definer:null},{ledger_tables_session_owner_access:4}]) {
   await assert.rejects(inspectDatabaseAccess({query:async()=>({rows:[{...fixture,...patch}]})}),/incomplete or unsafe/);
 }
 await assert.rejects(inspectDatabaseAccess({query:async()=>({rows:[]})}),/unexpected result/);
});

test("database access audit rejects unsafe schema before query",async()=>{
 await assert.rejects(inspectDatabaseAccess({query(){assert.fail("unexpected query");}},{schema:"public;invalid"}),/Invalid database access audit schema/);
});
