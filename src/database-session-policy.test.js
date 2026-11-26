import test from "node:test";
import assert from "node:assert/strict";
import {restrictedRuntimeConnectionOptions,guardRestrictedPoolCheckouts} from "./database-session-policy.js";

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

test("checkout guard validates promise and callback consumers and destroys drifted connections",async()=>{
 const calls=[];
 let safe=true;
 const client={getTransactionStatus(){return "I";},async query(sql,params){assert.match(sql,/current_schemas/);assert.deepEqual(params,["public"]);return {rows:[{same_role:true,safe_path:safe,origin_mode:true}]}},release(discard){calls.push(discard);}};
 const pool={async connect(){client.release=discard=>calls.push(discard);return client;}};
 guardRestrictedPoolCheckouts(pool);
 assert.equal(await pool.connect(),client);
 client.release();
 await new Promise((resolve,reject)=>pool.connect((error,value,release)=>{
   if(error)return reject(error);
   assert.equal(value,client);assert.equal(release,client.release);release();resolve();
 }));
 safe=false;
 await assert.rejects(pool.connect(),/settings incompatible/);
 await new Promise(resolve=>pool.connect((error,value)=>{
   assert.match(error.message,/settings incompatible/);assert.equal(value,undefined);resolve();
 }));
 assert.deepEqual(calls,[undefined,undefined,true,true]);
});

test("checkout and release discard non-idle and unverified transaction states",async()=>{
 let status="T",queries=0;const discarded=[];
 const client={getTransactionStatus(){return status;},async query(){queries++;status="I";return {rows:[{same_role:true,safe_path:true,origin_mode:true}]} }};
 const pool={async connect(){client.release=reason=>discarded.push(reason);return client;}};
 guardRestrictedPoolCheckouts(pool);
 for(const state of ["T","E",undefined]){
  status=state;
  await assert.rejects(pool.connect(),/settings incompatible/);
 }
 assert.equal(queries,0);
 status=null;const fresh=await pool.connect();assert.equal(queries,1);
 status="T";fresh.release();
 status="I";const healthy=await pool.connect();healthy.release();
 assert.deepEqual(discarded,[true,true,true,true,undefined]);
});
