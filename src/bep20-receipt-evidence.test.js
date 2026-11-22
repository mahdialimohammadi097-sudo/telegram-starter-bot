import test from "node:test";
import assert from "node:assert/strict";
import {verifyBep20DepositReceipt} from "./bep20-receipt-evidence.js";
const tokenContract="0x"+"a".repeat(40), depositAddress="0x"+"b".repeat(40);
const txHash="0x"+"c".repeat(64), hash="0x"+"d".repeat(64);
const block={hash,number:"0x64"}, transaction={hash:txHash,blockHash:hash,blockNumber:"0x64"};
const log={address:tokenContract,topics:["0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef","0x"+"0".repeat(24)+"e".repeat(40),"0x"+"0".repeat(24)+"b".repeat(40)],data:"0x"+"0".repeat(48)+"0de0b6b3a7640000",logIndex:"0x0",transactionHash:txHash,blockHash:hash};
const receipt={transactionHash:txHash,blockHash:hash,blockNumber:"0x64",status:"0x1",logs:[log]};
const base={receipt,transaction,block,head:"0x77",tokenContract,depositAddress};
test("accept exact successful confirmed transfer and canonical event key",()=>{
 const events=verifyBep20DepositReceipt(base);
 assert.equal(events.length,1);
 assert.equal(events[0].eventKey,`bsc:56:${txHash}:0`);
 assert.equal(events[0].amountBaseUnits,"1000000000000000000");
});
test("reject failed, reorged, and unconfirmed transactions",()=>{
 for(const change of [{receipt:{...receipt,status:"0x0"}},{block:{...block,hash:"0x"+"f".repeat(64)}},{head:"0x76"}]){
  assert.throws(()=>verifyBep20DepositReceipt({...base,...change}));
 }
});
test("reject wrong contract, destination and mismatched receipt log",()=>{
 for(const change of [{tokenContract:"0x"+"f".repeat(40)},{depositAddress:"0x"+"f".repeat(40)},{receipt:{...receipt,logs:[{...log,transactionHash:"0x"+"f".repeat(64)}]}}]){
  assert.throws(()=>verifyBep20DepositReceipt({...base,...change}));
 }
});
test("reject malformed confirmation settings and noncanonical block numbers",()=>{
 for(const change of [{minConfirmations:0},{head:"100"},{block:{...block,number:"0x064"}}]){
  assert.throws(()=>verifyBep20DepositReceipt({...base,...change}));
 }
});

test("reject duplicate event indices to prevent double-credit attribution",()=>{
 assert.throws(()=>verifyBep20DepositReceipt({...base,receipt:{...receipt,logs:[log,{...log} ]}}),/Duplicate transfer log index/);
});
test("allow distinct transfer logs within a single receipt",()=>{
 const events=verifyBep20DepositReceipt({...base,receipt:{...receipt,logs:[log,{...log,logIndex:"0x1"}]}});
 assert.deepEqual(events.map(e=>e.eventKey),[`bsc:56:${txHash}:0`,`bsc:56:${txHash}:1`]);
});

test("reject removed transfer logs and inconsistent log block numbers",()=>{
 for(const badLog of [
  {...log,removed:true},
  {...log,removed:"true"},
  {...log,removed:1},
  {...log,removed:null},
  {...log,blockNumber:"0x65"},
  {...log,blockNumber:"0x64",removed:true}
 ]) assert.throws(()=>verifyBep20DepositReceipt({...base,receipt:{...receipt,logs:[badLog]}}),/Inconsistent transfer log/);
 assert.equal(verifyBep20DepositReceipt({...base,receipt:{...receipt,logs:[{...log,blockNumber:"0x64",removed:false}]}}).length,1);
});
