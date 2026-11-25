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

test("rejects unsafe or noncanonical log indices and oversized RPC heights",()=>{
 for(const logIndex of [Number.MAX_SAFE_INTEGER+1,1.25,{},["1"],"01","0x01","0x"+"f".repeat(65),(1n<<256n).toString()]){
  assert.throws(()=>verifyBep20DepositReceipt({...base,receipt:{...receipt,logs:[{...log,logIndex}]}}),/log index|RPC quantity/);
 }
 assert.throws(()=>verifyBep20DepositReceipt({...base,head:"0x"+"f".repeat(65)}),/Invalid RPC quantity/);
});

test("rejects self-transfers, mint logs and noncanonical sender topics",()=>{
 for(const sender of [log.topics[2],"0x"+"0".repeat(64),"0x"+"f".repeat(24)+"e".repeat(40)]){
  const changed={...log,topics:[log.topics[0],sender,log.topics[2]]};
  assert.throws(()=>verifyBep20DepositReceipt({...base,receipt:{...receipt,logs:[changed]}}),/Invalid transfer sender/);
 }
});

test("rejects zero-address policy and coercible canonical hashes",()=>{
 const zero="0x"+"0".repeat(40);
 for(const change of [{tokenContract:zero},{depositAddress:zero},{receipt:{...receipt,transactionHash:[txHash]},transaction:{...transaction,hash:[txHash]}}]){
  assert.throws(()=>verifyBep20DepositReceipt({...base,...change}));
 }
});
test("rejects reused log indices even for unrelated token contracts",()=>{
 const other={...log,address:"0x"+"f".repeat(40)};
 assert.throws(()=>verifyBep20DepositReceipt({...base,receipt:{...receipt,logs:[other,log]}}),/Duplicate transfer log index/);
});
test("requires consistent transaction indexes when any relevant index is supplied",()=>{
 const indexed={...base,transaction:{...transaction,transactionIndex:"0x2"},receipt:{...receipt,transactionIndex:"0x2",logs:[{...log,transactionIndex:"0x2"}]}};
 assert.equal(verifyBep20DepositReceipt(indexed).length,1);
 for(const i of ["0x1",null,undefined,"0x02"]){
  assert.throws(()=>verifyBep20DepositReceipt({...indexed,transaction:{...indexed.transaction,transactionIndex:i}}));
  assert.throws(()=>verifyBep20DepositReceipt({...indexed,receipt:{...indexed.receipt,logs:[{...log,transactionIndex:i}]}}));
 }
});
