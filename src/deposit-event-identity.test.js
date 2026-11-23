import test from "node:test";
import assert from "node:assert/strict";
import {normalizeDepositEventIdentity as eventKey} from "./deposit-event-identity.js";
const tx="0x"+"Ab".repeat(32);
test("same chain transaction and log always yield same event identity",()=>{
 assert.equal(eventKey({chainId:56,transactionHash:tx,logIndex:"2"}),eventKey({chainId:56,transactionHash:tx.toLowerCase(),logIndex:2}));
});
test("different log indexes remain distinct even within one transaction",()=>{
 assert.notEqual(eventKey({chainId:56,transactionHash:tx,logIndex:1}),eventKey({chainId:56,transactionHash:tx,logIndex:2}));
});
test("rejects unsupported chains and malformed or unsafe identities",()=>{
 for(const input of [{chainId:1,transactionHash:tx,logIndex:0},{chainId:56,transactionHash:"0x1",logIndex:0},{chainId:56,transactionHash:tx,logIndex:-1},{chainId:56,transactionHash:tx,logIndex:"01"},{chainId:56,transactionHash:tx,logIndex:1.5},{chainId:56,transactionHash:tx,logIndex:4294967296},{chainId:56,transactionHash:tx,logIndex:Number.MAX_SAFE_INTEGER}])
  assert.throws(()=>eventKey(input));
});
