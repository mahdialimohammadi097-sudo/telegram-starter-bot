import test from "node:test";
import assert from "node:assert/strict";
import {inspectDepositIdempotency as inspect} from "./deposit-idempotency-db-inspection.js";
const eventKey="bsc:56:0x"+"a".repeat(64)+":2";
test("reads evidence and ledger identities with bound parameters",async()=>{
 let calls=0;
 const client={query:async(sql,params)=>{
  calls++;assert.match(sql,/verified_deposit_evidence/);
  assert.match(sql,/ledger_transactions/);
  assert.deepEqual(params,[eventKey,"deposit:"+eventKey]);
  return {rows:[{evidence_exists:false,ledger_exists:false}],rowCount:1};
 }};
 assert.deepEqual(await inspect(client,{eventKey}),{eventKey,unrecordedAtInspection:true});
 assert.equal(calls,1);
});
test("rejects duplicates in either or both records",async()=>{
 for(const [evidence_exists,ledger_exists] of [[true,false],[false,true],[true,true]]){
  await assert.rejects(inspect({query:async()=>({
   rows:[{evidence_exists,ledger_exists}],rowCount:1
  })},{eventKey}),/already recorded/);
 }
});
test("rejects malformed DB results without allowing financial processing",async()=>{
 for(const result of [null,{rows:[]},{rows:[{}],rowCount:1},
  {rows:[{evidence_exists:0,ledger_exists:false}],rowCount:1},
  {rows:[{evidence_exists:false,ledger_exists:false}],rowCount:2}]){
  await assert.rejects(inspect({query:async()=>result},{eventKey}),/Malformed/);
 }
});
test("rejects unsafe identity and schema before SQL",async()=>{
 let calls=0;const client={query:async()=>{calls++;return {rows:[]}}};
 for(const input of [{eventKey:"bad"},{eventKey,schema:"public;drop"},
  {eventKey:eventKey.toUpperCase()},{eventKey:eventKey+":1"}]){
  await assert.rejects(inspect(client,input),/Invalid/);
 }
 assert.equal(calls,0);
});

test("concurrent read-only preflights cannot claim the same event",async()=>{
 // Both callers see the same empty snapshot. A passing preflight is NOT
 // permission to post: the eventual writer needs atomic unique-key claims.
 const observed=[];
 const client={query:async(_sql,params)=>{
  observed.push(params[0]);
  await Promise.resolve();
  return {rows:[{evidence_exists:false,ledger_exists:false}],rowCount:1};
 }};
 const results=await Promise.all([
  inspect(client,{eventKey}),inspect(client,{eventKey})
 ]);
 assert.equal(observed.length,2);
 assert.ok(results.every(r=>r.unrecordedAtInspection===true));
 assert.equal(results[0].eventKey,results[1].eventKey);
});
