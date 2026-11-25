// Dedicated standalone security rehearsal, never run on a production database.
import test from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import {inspectDepositSchemaReadOnly,deliverAdminSchemaAudit} from "../src/admin-schema-audit.js";
const url = process.env.SECURITY_REHEARSAL_URL;
assert.equal(process.env.GITHUB_ACTIONS,"true","CI only");
const target=new URL(url);
assert.equal(target.protocol,"postgresql:");
assert.ok(["localhost","127.0.0.1"].includes(target.hostname));
assert.equal(target.port,"5432");
assert.equal(target.pathname,"/profino_security_rehearsal");
assert.equal(target.search,"");
assert.equal(target.hash,"");
test("real PostgreSQL 17 metadata audit is read-only and releases a clean session",async()=>{
 const pool=new pg.Pool({connectionString:url,max:1});
 try{
  const v=await pool.query("SELECT current_setting('server_version_num')::int AS version, current_database() AS db");
  assert.equal(Math.floor(v.rows[0].version/10000),17);
  assert.equal(v.rows[0].db,"profino_security_rehearsal");
  const statements=[];
  const wrapped={async connect(){
   const client=await pool.connect();
   return {async query(sql,params){
    statements.push(sql);
    if(sql.includes("information_schema.columns")){
     const state=(await client.query("SELECT current_setting('transaction_read_only') AS ro,current_setting('transaction_isolation') AS iso,current_setting('statement_timeout') AS timeout")).rows[0];
     assert.equal(state.ro,"on");
     assert.equal(state.iso,"repeatable read");
     assert.equal(state.timeout,"5s");
    }
    return client.query(sql,params);
   },release(error){client.release(error);}};
  }};
  const report=await inspectDepositSchemaReadOnly(wrapped);
  assert.equal(report.structuralReady,false);
  assert.equal(report.realDepositsEnabled,false);
  assert.equal(report.financialActivationReady,false);
  assert.ok(report.missing.includes("verified_deposit_evidence.event_key"));
  assert.equal(statements.at(-1),"ROLLBACK");
  assert.equal((await pool.query("SELECT current_setting('transaction_read_only') AS ro")).rows[0].ro,"off");
  const logs=[],messages=[];
  const failed={async connect(){
   const client=await pool.connect();
   return {async query(sql,params){
    if(sql.includes("information_schema.columns"))return client.query("SELECT 1/0");
    return client.query(sql,params);
   },release(error){client.release(error);}};
  }};
  assert.equal(await deliverAdminSchemaAudit({pool:failed,adminId:123,sendMessage:async(...args)=>messages.push(args),logCode:code=>logs.push(code)}),false);
  assert.deepEqual(logs,["22012"]);
  assert.deepEqual(messages,[]);
  assert.equal((await pool.query("SELECT 1 AS ok")).rows[0].ok,1);
 }finally{await pool.end();}
});
