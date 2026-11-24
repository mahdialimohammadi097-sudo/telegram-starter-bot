import test from "node:test";
import assert from "node:assert/strict";
import {readVerifiedBep20Deposit} from "./bep20-rpc-reader.js";
const tokenContract="0x"+"a".repeat(40),depositAddress="0x"+"b".repeat(40);
const txHash="0x"+"c".repeat(64),blockHash="0x"+"d".repeat(64);
const block={hash:blockHash,number:"0x64"};
const receipt={transactionHash:txHash,blockHash,blockNumber:"0x64",status:"0x1",
 logs:[{address:tokenContract,topics:["0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef","0x"+"0".repeat(24)+"e".repeat(40),"0x"+"0".repeat(24)+"b".repeat(40)],data:"0x"+(10n**18n).toString(16).padStart(64,"0"),logIndex:"0x0",transactionHash:txHash,blockHash}]};
const transaction={hash:txHash,blockHash,blockNumber:"0x64"};
const responses={eth_chainId:"0x38",eth_getTransactionReceipt:receipt,eth_getTransactionByHash:transaction,eth_getBlockByNumber:block,eth_blockNumber:"0x77"};
const args={transactionHash:txHash,tokenContract,depositAddress};
test("reads BSC chain and canonical block before producing verified evidence",async()=>{
 const calls=[];
 const result=await readVerifiedBep20Deposit({...args,rpc:async(method,params)=>{calls.push([method,params]);return responses[method]}});
 assert.equal(result[0].eventKey,`bsc:56:${txHash}:0`);
 assert.equal(calls.filter(c=>c[0]==="eth_getBlockByNumber").length,2);
 for (const method of ["eth_getTransactionByHash","eth_chainId","eth_blockNumber"]) assert.equal(calls.filter(c=>c[0]===method).length,2);
 assert.equal(calls.at(-1)[0],"eth_getBlockByNumber");
});
test("rejects wrong chain and missing RPC response",async()=>{
 for(const value of ["0x1",null]) await assert.rejects(readVerifiedBep20Deposit({...args,rpc:async m=>m==="eth_chainId"?value:responses[m]}));
});
test("rejects block changes between independent canonical reads",async()=>{
 let count=0;
 await assert.rejects(readVerifiedBep20Deposit({...args,rpc:async m=>{
   if(m==="eth_getBlockByNumber" && ++count===2) return {...block,hash:"0x"+"f".repeat(64)};
   return responses[m];
 }}),/Canonical block changed/);
});

test("rejects receipt changes and checks canonical block after the last receipt",async()=>{
 const calls=[];
 let count=0;
 await assert.rejects(readVerifiedBep20Deposit({...args,rpc:async m=>{
  calls.push(m);
  if(m==="eth_getTransactionReceipt" && ++count===2)
   return {...receipt,logs:[{...receipt.logs[0],data:"0x"+"0".repeat(63)+"1"}]};
  return responses[m];
 }}),/Transfer evidence changed/);
 assert.equal(count,2);
 // Changed logs fail before any additional network lookup.
 assert.equal(calls.at(-1),"eth_getTransactionReceipt");
});
test("rejects mutation of a reused RPC receipt object",async()=>{
 const mutable=structuredClone(receipt);
 let count=0;
 await assert.rejects(readVerifiedBep20Deposit({...args,rpc:async m=>{
  if(m==="eth_getTransactionReceipt"){
   if(++count===2) mutable.logs[0].data="0x"+"0".repeat(63)+"1";
   return mutable;
  }
  return responses[m];
 }}),/Transfer evidence changed/);
});
test("redacts transport errors and rejects coercible configuration before RPC",async()=>{
 await assert.rejects(readVerifiedBep20Deposit({...args,rpc:async()=>{throw new Error("synthetic-sensitive-detail")}}),
  error=>error.message==="Trusted RPC request failed" && !error.cause);
 let calls=0;
 await assert.rejects(readVerifiedBep20Deposit({...args,transactionHash:{toString:()=>txHash},rpc:async()=>{calls++}}),
  /Invalid trusted RPC reader/);
 assert.equal(calls,0);
});

test("rejects a changed transaction, chain or regressed head in repeated observations",async()=>{
 for (const [method,value,pattern] of [
  ["eth_getTransactionByHash",{...transaction,blockHash:txHash},/transaction changed/],
  ["eth_chainId","0x1",/chain changed/],
  ["eth_blockNumber","0x76",/head changed or regressed/],
  ["eth_blockNumber","invalid",/head changed or regressed/]
 ]) {
  let count=0;
  await assert.rejects(readVerifiedBep20Deposit({...args,rpc:async m=>{
   if(m===method && ++count===2)return value;
   return responses[m];
  }}),pattern);
 }
});
test("rejects changing sender even when amount and event identity stay unchanged",async()=>{
 let count=0;
 await assert.rejects(readVerifiedBep20Deposit({...args,rpc:async m=>{
  if(m==="eth_getTransactionReceipt" && ++count===2){
   const changed=structuredClone(receipt);
   changed.logs[0].topics[1]="0x"+"0".repeat(24)+"f".repeat(40);
   return changed;
  }
  return responses[m];
 }}),/Transfer evidence changed/);
});
