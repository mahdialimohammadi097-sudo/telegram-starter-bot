import test from "node:test";
import assert from "node:assert/strict";
import {draftBscDepositJournal as draft} from "./deposit-ledger-journal-draft.js";
const eventKey="bsc:56:0x"+"a".repeat(64)+":2";
const evidence={eventKey,userId:"12",walletId:"3",units:"125000000"};
const accounts={userAvailableAccountId:"4",platformClearingAccountId:"5"};
test("builds exact balanced USDT proposal without database calls",()=>{
 const result=draft({evidence,...accounts});
 assert.equal(result.idempotencyKey,"deposit:"+eventKey);
 assert.deepEqual(result.entries.map(e=>e.entry_type),["debit","credit"]);
 assert.deepEqual(result.entries.map(e=>e.amount),["1.25000000","1.25000000"]);
 assert.ok(Object.isFrozen(result)&&Object.isFrozen(result.entries)&&Object.isFrozen(result.entries[0]));
});
test("rejects same clearing and user account, malformed identities and zero",()=>{
 for(const input of [
  {...accounts,userAvailableAccountId:"5"},
  {...accounts,userAvailableAccountId:"0"},
  {...accounts,platformClearingAccountId:"9223372036854775808"}
 ]){
  assert.throws(()=>draft({evidence,...input}));
 }
 for(const bad of [
  {...evidence,eventKey:"bsc:97:0x"+"a".repeat(64)+":2"},
  {...evidence,units:"0"},
  {...evidence,units:"1.1"},
  {...evidence,units:"9".repeat(27)},
  {...evidence,userId:"9223372036854775808"}
 ])assert.throws(()=>draft({evidence:bad,...accounts}));
});
test("retains eight decimal precision and rejects excessive units",()=>{
 const result=draft({evidence:{...evidence,units:"1"},...accounts});
 assert.equal(result.entries[0].amount,"0.00000001");
 assert.throws(()=>draft({evidence:{...evidence,units:"1"+"0".repeat(26)},...accounts}));
});
