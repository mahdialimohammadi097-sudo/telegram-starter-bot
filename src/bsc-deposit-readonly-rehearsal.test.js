import test from "node:test";
import assert from "node:assert/strict";
import {rehearseBscDepositJournal as rehearse} from "./bsc-deposit-readonly-rehearsal.js";
test("starts an explicit read-only transaction, locks bounded, and rolls back on validation failure",async()=>{
 const statements=[];
 const client={query:async(sql)=>{
  statements.push(sql);
  if(sql.includes("deposit_address_ownership_history"))
   return {rows:[],rowCount:0};
  return {rows:[],rowCount:0};
 }};
 await assert.rejects(rehearse({
  client,rpc:async method=>({
   eth_chainId:"0x38",
   eth_getTransactionReceipt:{transactionHash:"0x"+"a".repeat(64),status:"0x0"}
  })[method],
  transactionHash:"0x"+"a".repeat(64),
  expected:{depositAddress:"0x"+"d".repeat(40)},
  expectedUserId:"12",userAvailableAccountId:"4",platformClearingAccountId:"5"
 }));
 assert.deepEqual(statements,[
  "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY",
  "SET LOCAL lock_timeout = '2000ms'",
  "SET LOCAL statement_timeout = '8000ms'",
  "ROLLBACK"
 ]);
 assert.ok(statements.every(s=>!/\b(?:INSERT|UPDATE|DELETE|COMMIT)\b/.test(s)));
});
test("rejects missing dedicated database client without issuing SQL",async()=>{
 await assert.rejects(rehearse({}),/Dedicated PostgreSQL client required/);
});
test("does not hide rollback failure",async()=>{
 const client={query:async sql=>{
  if(sql==="ROLLBACK")throw new Error("connection lost");
  if(sql.startsWith("SET LOCAL"))throw new Error("timeout setup failed");
 }};
 await assert.rejects(rehearse({client}),/rollback failed/);
});
