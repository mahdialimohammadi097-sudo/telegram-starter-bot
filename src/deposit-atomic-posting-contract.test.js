import test from "node:test";
import assert from "node:assert/strict";
import {exerciseAtomicDepositPosting as exercise} from "./deposit-atomic-posting-contract.js";
import {draftBscDepositJournal} from "./deposit-ledger-journal-draft.js";
const draft=()=>structuredClone(draftBscDepositJournal({evidence:{eventKey:"bsc:56:0x"+"a".repeat(64)+":0",userId:"1",walletId:"2",units:"1000000000"},userAvailableAccountId:"3",platformClearingAccountId:"4"}));
function fixture(fail){
 const calls=[];
 let legs=0;
 const adapter={
 begin:async()=>{calls.push("begin")},
 claim:async()=>{calls.push("claim");return fail!=="claim"},
 insertLeg:async()=>{calls.push("leg");return !(++legs===2&&fail==="leg")},
 commit:async()=>{calls.push("commit");if(fail==="commit")throw Error("commit failed")},
 rollback:async()=>{calls.push("rollback")}
 };
 return {calls,adapter};
}
test("fixture posts both legs before commit",async()=>{
 const {calls,adapter}=fixture();
 assert.equal((await exercise(adapter,draft())).status,"fixture_posted");
 assert.deepEqual(calls,["begin","claim","leg","leg","commit"]);
});
for(const [fail,expected] of [["claim",["begin","claim","rollback"]],["leg",["begin","claim","leg","leg","rollback"]],["commit",["begin","claim","leg","leg","commit","rollback"]]]){
 test("fixture rolls back on "+fail+" failure",async()=>{
  const {calls,adapter}=fixture(fail);
  await assert.rejects(exercise(adapter,draft()));
  assert.deepEqual(calls,expected);
 });
}
test("invalid draft never opens transaction",async()=>{
 const {calls,adapter}=fixture();
 const d=draft();d.entries.pop();
 await assert.rejects(exercise(adapter,d));
 assert.deepEqual(calls,[]);
});
