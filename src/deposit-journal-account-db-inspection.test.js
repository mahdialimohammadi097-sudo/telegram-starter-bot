import test from "node:test";
import assert from "node:assert/strict";
import {inspectDepositJournalAccounts as inspect} from "./deposit-journal-account-db-inspection.js";
const input={userId:"12",userAvailableAccountId:"4",platformClearingAccountId:"5"};
const accounts=[{id:"4",user_id:"12",account_type:"AVAILABLE",currency:"USDT"},
 {id:"5",user_id:null,account_type:"CLEARING",currency:"USDT"}];
test("reads and locks both account identities using bound bigint parameters",async()=>{
 let calls=0;
 const client={query:async(sql,params)=>{
  calls++;assert.match(sql,/FOR SHARE/);
  assert.match(sql,/FROM "public"\.ledger_accounts/);
  assert.deepEqual(params,["4","5"]);
  return {rows:accounts,rowCount:2};
 }};
 assert.deepEqual(await inspect(client,input),{
  userAvailableAccountId:"4",platformClearingAccountId:"5"
 });
 assert.equal(calls,1);
});
test("rejects missing, duplicated and ambiguous DB account identities",async()=>{
 for(const rows of [[],[accounts[0]],[accounts[0],accounts[0]],
  [accounts[0],{...accounts[1],id:"6"}]]){
  await assert.rejects(inspect({query:async()=>({rows,rowCount:rows.length})},input));
 }
 await assert.rejects(inspect({query:async()=>({rows:accounts,rowCount:1})},input));
});
test("rejects account identity and ownership mismatches",async()=>{
 for(const rows of [
  [{...accounts[0],user_id:"13"},accounts[1]],
  [{...accounts[0],currency:"BTC"},accounts[1]],
  [{...accounts[0],account_type:"INVESTED"},accounts[1]],
  [accounts[0],{...accounts[1],user_id:"12"}],
  [accounts[0],{...accounts[1],account_type:"AVAILABLE"}]
 ]){
  await assert.rejects(inspect({query:async()=>({rows,rowCount:2})},input),/identity mismatch/);
 }
});
test("rejects malformed input and schema injection without querying DB",async()=>{
 let calls=0;const client={query:async()=>{calls++;return {rows:accounts,rowCount:2}}};
 for(const patch of [{schema:"public;DROP TABLE users"},{userId:"0"},
  {userAvailableAccountId:"-1"},{platformClearingAccountId:"4"},
  {userAvailableAccountId:"9223372036854775808"}]){
  await assert.rejects(inspect(client,{...input,...patch}),/inspection input/);
 }
 assert.equal(calls,0);
});
