import test from "node:test";
import assert from "node:assert/strict";
import {assertTenUsdtPilotJournal as check} from "./ten-usdt-pilot-gate.js";
const valid={eventKey:"bsc:56:0x"+"a".repeat(64)+":0",
 entries:[{amount:"10.00000000",currency:"USDT",entry_type:"debit"},
 {amount:"10.00000000",currency:"USDT",entry_type:"credit"}]};
valid.idempotencyKey="deposit:"+valid.eventKey;
test("accepts only a balanced-shape exact 10 USDT pilot proposal",()=>{
 assert.equal(check(valid),valid);
});
test("rejects incorrect, fractional and zero pilot amounts",()=>{
 for(const amount of ["0.00000000","9.99999999","10.00000001","20.00000000","10","10.000000001"]){
  assert.throws(()=>check({...valid,entries:[valid.entries[0],{...valid.entries[1],amount}]}));
 }
});
test("rejects missing entries, wrong currency, direction or idempotency",()=>{
 for(const journal of [
  {...valid,entries:[]},
  {...valid,entries:[valid.entries[0]]},
  {...valid,entries:[{...valid.entries[0],currency:"BTC"},valid.entries[1]]},
  {...valid,entries:[{...valid.entries[0],entry_type:"credit"},valid.entries[1]]},
  {...valid,idempotencyKey:"deposit:other"},
  null
 ])assert.throws(()=>check(journal));
});
