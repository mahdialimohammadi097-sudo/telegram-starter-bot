import test from "node:test";
import assert from "node:assert/strict";
import {inspectDepositSchemaReadOnly} from "./admin-schema-audit.js";

test("read-only schema audit reports missing evidence without accessing user rows",async()=>{
 const statements=[];
 const client={query:async(sql)=>{
  statements.push(sql);
  if(sql.includes("information_schema.columns"))return {rows:[
   {table_name:"wallets",column_name:"id"}]};
  if(sql.includes("FROM pg_index"))return {rows:[]};
  return {rows:[]};
 },release:()=>{}};
 const result=await inspectDepositSchemaReadOnly({connect:async()=>client});
 assert.equal(result.structuralReady,false);
 assert.equal(result.financialActivationReady,false);
 assert.equal(result.realDepositsEnabled,false);
 assert.ok(result.missing.includes("verified_deposit_evidence.event_key"));
 assert.ok(result.missing.includes("unique:verified_deposit_evidence.event_key"));
 assert.equal(statements[0],"BEGIN READ ONLY ISOLATION LEVEL REPEATABLE READ");
 assert.equal(statements.at(-1),"ROLLBACK");
 assert.ok(!statements.some(sql=>/SELECT\s+\*|FROM\s+users\b/i.test(sql)));
});
test("read-only schema audit rolls back when catalog inspection fails",async()=>{
 let rolledBack=false,released=false;
 const client={query:async(sql)=>{
  if(sql==="ROLLBACK"){rolledBack=true;return {rows:[]};}
  if(sql.includes("information_schema"))throw Error("catalog unavailable");
  return {rows:[]};
 },release:()=>{released=true;}};
 await assert.rejects(inspectDepositSchemaReadOnly({connect:async()=>client}),/catalog unavailable/);
 assert.equal(rolledBack,true);
 assert.equal(released,true);
});
