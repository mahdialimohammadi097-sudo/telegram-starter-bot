import test from "node:test";
import assert from "node:assert/strict";
import {inspectDepositJournalAccounts} from "./deposit-journal-account-db-inspection.js";
import {inspectHistoricalWalletFromDatabase} from "./deposit-historical-wallet-db-inspection.js";
test("read-only rehearsal removes row locks from ledger account inspection",async()=>{
 const client={query:async(sql)=>{
  assert.doesNotMatch(sql,/FOR SHARE|FOR UPDATE/);
  return {rows:[
   {id:"4",user_id:"12",account_type:"AVAILABLE",currency:"USDT"},
   {id:"5",user_id:null,account_type:"CLEARING",currency:"USDT"}
  ],rowCount:2};
 }};
 await inspectDepositJournalAccounts(client,{
  userId:"12",userAvailableAccountId:"4",platformClearingAccountId:"5",lockRows:false
 });
});
test("historical wallet query is lock-free in read-only mode and fails closed on absent ownership",async()=>{
 const client={query:async(sql)=>{
  assert.doesNotMatch(sql,/FOR SHARE|FOR UPDATE/);
  return {rows:[],rowCount:0};
 }};
 await assert.rejects(inspectHistoricalWalletFromDatabase(client,{
  eventBlockNumber:"1",walletAddress:"0x"+"a".repeat(40),expectedUserId:"12",
  lockRows:false
 }),/Missing or ambiguous historical wallet owner/);
});
test("invalid lock mode is rejected before database query",async()=>{
 let calls=0;const client={query:async()=>{calls++}};
 await assert.rejects(inspectDepositJournalAccounts(client,{
  userId:"12",userAvailableAccountId:"4",platformClearingAccountId:"5",lockRows:"false"
 }),/Invalid ledger account inspection input/);
 await assert.rejects(inspectHistoricalWalletFromDatabase(client,{
  eventBlockNumber:"1",walletAddress:"0x"+"a".repeat(40),expectedUserId:"12",
  lockRows:"false"
 }),/Invalid schema/);
 assert.equal(calls,0);
});
