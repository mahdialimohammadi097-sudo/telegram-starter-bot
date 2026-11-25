import test from "node:test";
import assert from "node:assert/strict";
import { inspectDatabaseAccess } from "./database-access-audit.js";
const fixture = { read_only:true, tls:false, server_major:17, privileged_role_membership:true,
 public_schema_create:true, ledger_tables_present:3, ledger_tables_owned:3,
 ledger_tables_truncatable:3, ledger_tables_trigger_privilege:3 };
test("access audit returns only explicit role and transport evidence", async () => {
 const result = await inspectDatabaseAccess({query:async sql => {
   assert.match(sql,/pg_catalog.pg_stat_ssl/);
   assert.match(sql,/pg_has_role/);
   return {rows:[{...fixture, unexpected:"synthetic sensitive data"}]};
 }});
 assert.deepEqual(result, fixture);
 assert.ok(Object.isFrozen(result));
});
test("access audit rejects incomplete and non-read-only evidence",async()=>{
 for (const patch of [{read_only:false},{tls:null},{ledger_tables_present:0},{server_major:null},{ledger_tables_owned:4}]) {
   await assert.rejects(inspectDatabaseAccess({query:async()=>({rows:[{...fixture,...patch}]})}),/incomplete or unsafe/);
 }
 await assert.rejects(inspectDatabaseAccess({query:async()=>({rows:[]})}),/unexpected result/);
});
