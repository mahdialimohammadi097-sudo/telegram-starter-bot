import test from "node:test";
import assert from "node:assert/strict";
import {restrictedRuntimeConnectionOptions} from "./database-session-policy.js";

test("legacy connection configuration is unchanged",()=>{
  assert.deepEqual(restrictedRuntimeConnectionOptions({DATABASE_URL:"postgresql://localhost/db?options=legacy"}),{});
});
test("restricted connection options pin catalog and application before temporary schema",()=>{
  assert.deepEqual(restrictedRuntimeConnectionOptions({PROFINO_RUNTIME_SCHEMA_MODE:"verify-only",DATABASE_URL:"postgresql://localhost/db"}),{options:"-c search_path=pg_catalog,public,pg_temp"});
  assert.deepEqual(restrictedRuntimeConnectionOptions({}, {schema:"fixture",force:true}),{options:"-c search_path=pg_catalog,fixture,pg_temp"});
});
test("restricted startup rejects URL option overrides and unsafe schema without revealing input",()=>{
  for(const parameter of ["options=-c%20search_path%3Dother","%6fptions=private-fixture","OPTIONS=private-fixture","options="]){
    assert.throws(()=>restrictedRuntimeConnectionOptions({DATABASE_URL:"postgresql://localhost/db?"+parameter},{force:true}),error=>error.message==="Restricted runtime URL startup options conflict");
  }
  assert.throws(()=>restrictedRuntimeConnectionOptions({DATABASE_URL:"private-fixture"},{force:true}),error=>error.message==="Invalid DATABASE_URL configuration");
  assert.throws(()=>restrictedRuntimeConnectionOptions({},{schema:"public;invalid",force:true}),/Invalid restricted runtime schema/);
});
