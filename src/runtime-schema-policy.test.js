import test from "node:test";
import assert from "node:assert/strict";
import {runtimeSchemaMode,prepareRuntimeSchema,verifyRuntimeSchema} from "./runtime-schema-policy.js";

test("runtime schema mode is explicit and invalid settings fail before operations",async()=>{
 assert.equal(runtimeSchemaMode({}),"legacy-prepare");
 assert.equal(runtimeSchemaMode({PROFINO_RUNTIME_SCHEMA_MODE:"verify-only"}),"verify-only");
 const forbidden=()=>assert.fail("unexpected schema operation");
 await assert.rejects(prepareRuntimeSchema({env:{PROFINO_RUNTIME_SCHEMA_MODE:"true"},ensurePostHistorySchema:forbidden,ensureAdminOpsSchema:forbidden}),/Invalid/);
 const calls=[];
 await prepareRuntimeSchema({env:{},ensurePostHistorySchema:async()=>calls.push("posts"),ensureAdminOpsSchema:async()=>calls.push("admin")});
 assert.deepEqual(calls,["posts","admin"]);
});
test("verify-only never runs preparation even when schema verification fails",async()=>{
 const queries=[],releases=[];
 const pool={connect:async()=>({query:async sql=>{
  queries.push(sql);
  return sql.includes("pg_catalog.pg_class c")?{rows:[]}:{command:sql};
 },release(error){releases.push(error)}})};
 const forbidden=()=>assert.fail("DDL must not run");
 await assert.rejects(prepareRuntimeSchema({pool,env:{PROFINO_RUNTIME_SCHEMA_MODE:"verify-only"},ensurePostHistorySchema:forbidden,ensureAdminOpsSchema:forbidden}),/missing/);
 assert.match(queries[0],/READ ONLY/);
 assert.equal(queries.at(-1),"ROLLBACK");
 assert.ok(queries.every(sql=>!/\b(?:CREATE TABLE|ALTER TABLE|DROP TRIGGER|INSERT INTO)\b/.test(sql)));
 assert.deepEqual(releases,[undefined]);
 await assert.rejects(verifyRuntimeSchema(pool,{schema:"public; DROP TABLE users"}),/Invalid/);
});
