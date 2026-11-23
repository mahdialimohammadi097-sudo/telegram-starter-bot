import test from "node:test";
import assert from "node:assert/strict";
import {readBscDepositEvidence} from "./bsc-readonly-deposit-rpc.js";
const tx="0x"+"a".repeat(64),hash="0x"+"b".repeat(64),token="0x"+"c".repeat(40),to="0x"+"d".repeat(40);
const topic="0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const log={logIndex:"0x2",address:token,transactionHash:tx,blockHash:hash,blockNumber:"0x64",
 topics:[topic,"0x"+"0".repeat(24)+"e".repeat(40),"0x"+"0".repeat(24)+to.slice(2)],
 data:"0x"+(10n**18n).toString(16).padStart(64,"0")};
const receipt={transactionHash:tx,blockHash:hash,blockNumber:"0x64",status:"0x1",logs:[log]};
const expected={transactionHash:tx,tokenContract:token,depositAddress:to,logIndex:2,tokenDecimals:18,minConfirmations:12};
const makeRpc=(overrides={})=>async(method)=>{
 const values={eth_chainId:"0x38",eth_getTransactionReceipt:receipt,eth_getTransactionByHash:{hash:tx,blockHash:hash,blockNumber:"0x64"},
  eth_getBlockByNumber:{number:"0x64",hash},eth_blockNumber:"0x78",...overrides};
 return values[method];
};
test("reads canonical BSC evidence without crediting any account",async()=>{
 const result=await readBscDepositEvidence({rpc:makeRpc(),transactionHash:tx,expected});
 assert.equal(result.units,"100000000");
 assert.equal(result.eventKey,"bsc:56:"+tx+":2");
});
test("fails closed on wrong chain, receipt, block or insufficient head",async()=>{
 for(const overrides of [
  {eth_chainId:"0x61"},
  {eth_getTransactionReceipt:{...receipt,transactionHash:"0x"+"f".repeat(64)}},
  {eth_getBlockByNumber:{number:"0x64",hash:"0x"+"f".repeat(64)}},
  {eth_blockNumber:"0x64"},
  {eth_blockNumber:"0x20000000000000"}
 ]){
  await assert.rejects(readBscDepositEvidence({rpc:makeRpc(overrides),transactionHash:tx,expected}));
 }
});
test("detects changing canonical block across RPC reads",async()=>{
 let reads=0;
 const rpc=async(method)=>{
  if(method==="eth_getBlockByNumber"){
   reads++;
   return {number:"0x64",hash:reads===1?hash:"0x"+"f".repeat(64)};
  }
  return makeRpc()(method);
 };
 await assert.rejects(readBscDepositEvidence({rpc,transactionHash:tx,expected}),/canonical/);
});

test("rejects receipt changes between RPC observations",async()=>{
 let reads=0;
 const rpc=async(method)=>{
  if(method==="eth_getTransactionReceipt"){
   reads++;
   return reads===1?receipt:{...receipt,logs:[{...log,data:"0x"+(2n*10n**18n).toString(16).padStart(64,"0")}]};
  }
  return makeRpc()(method);
 };
 await assert.rejects(readBscDepositEvidence({rpc,transactionHash:tx,expected}),/receipt changed/);
});
test("rejects a disappearing receipt after canonical block inspection",async()=>{
 let reads=0;
 const rpc=async(method)=>{
  if(method==="eth_getTransactionReceipt")return ++reads===1?receipt:null;
  return makeRpc()(method);
 };
 await assert.rejects(readBscDepositEvidence({rpc,transactionHash:tx,expected}),/Missing RPC evidence/);
});

test("rejects transaction provenance mismatch",async()=>{
 for(const transaction of [
  {hash:"0x"+"f".repeat(64),blockHash:hash,blockNumber:"0x64"},
  {hash:tx,blockHash:"0x"+"f".repeat(64),blockNumber:"0x64"},
  {hash:tx,blockHash:hash,blockNumber:"0x65"}
 ]){
  await assert.rejects(readBscDepositEvidence({rpc:makeRpc({eth_getTransactionByHash:transaction}),transactionHash:tx,expected}),/provenance/);
 }
});
test("rejects chain identity changing during read",async()=>{
 let calls=0;
 const rpc=async(method)=>{
  if(method==="eth_chainId")return ++calls===1?"0x38":"0x61";
  return makeRpc()(method);
 };
 await assert.rejects(readBscDepositEvidence({rpc,transactionHash:tx,expected}),/chain changed/);
});

test("rejects transaction changing between first and final RPC reads",async()=>{
 let reads=0;
 const rpc=async(method)=>{
  if(method==="eth_getTransactionByHash"){
   reads++;
   return reads===1?{hash:tx,blockHash:hash,blockNumber:"0x64"}:
    {hash:tx,blockHash:"0x"+"f".repeat(64),blockNumber:"0x64"};
  }
  return makeRpc()(method);
 };
 await assert.rejects(readBscDepositEvidence({rpc,transactionHash:tx,expected}),/transaction changed/);
});
test("rejects transaction disappearing during final RPC read",async()=>{
 let reads=0;
 const rpc=async(method)=>{
  if(method==="eth_getTransactionByHash"){
   reads++;
   return reads===1?{hash:tx,blockHash:hash,blockNumber:"0x64"}:null;
  }
  return makeRpc()(method);
 };
 await assert.rejects(readBscDepositEvidence({rpc,transactionHash:tx,expected}),/Missing RPC evidence/);
});

test("rejects RPC head regression during evidence inspection",async()=>{
 let reads=0;
 const rpc=async(method)=>{
  if(method==="eth_blockNumber")return ++reads===1?"0x78":"0x64";
  return makeRpc()(method);
 };
 await assert.rejects(readBscDepositEvidence({rpc,transactionHash:tx,expected}),/head regressed/);
});

test("rejects a canonical block reorganization after final receipt inspection",async()=>{
 let reads=0;
 const rpc=async(method)=>{
  if(method==="eth_getBlockByNumber")
   return {number:"0x64",hash:++reads===3?"0x"+"f".repeat(64):hash};
  return makeRpc()(method);
 };
 await assert.rejects(readBscDepositEvidence({rpc,transactionHash:tx,expected}),/canonical block changed/);
});

test("rejects conflicting transaction positions in receipt and transaction",async()=>{
 const inconsistent={...receipt,transactionIndex:"0x2"};
 const rpc=makeRpc({eth_getTransactionReceipt:inconsistent,
  eth_getTransactionByHash:{hash:tx,blockHash:hash,blockNumber:"0x64",transactionIndex:"0x3"}});
 await assert.rejects(readBscDepositEvidence({rpc,transactionHash:tx,expected}),/provenance/);
});
test("rejects receipt transaction position changing during inspection",async()=>{
 let reads=0;
 const rpc=async(method)=>{
  if(method==="eth_getTransactionReceipt")
   return {...receipt,transactionIndex:++reads===1?"0x2":"0x3"};
  if(method==="eth_getTransactionByHash")
   return {hash:tx,blockHash:hash,blockNumber:"0x64",transactionIndex:"0x2"};
  return makeRpc()(method);
 };
 await assert.rejects(readBscDepositEvidence({rpc,transactionHash:tx,expected}),/receipt changed/);
});

test("rejects transaction index changing across RPC reads even if block identity is unchanged",async()=>{
 let reads=0;
 const rpc=async(method)=>{
  if(method==="eth_getTransactionByHash"){
   return {hash:tx,blockHash:hash,blockNumber:"0x64",transactionIndex:++reads===1?"0x2":"0x3"};
  }
  if(method==="eth_getTransactionReceipt")return {...receipt,transactionIndex:"0x2"};
  return makeRpc()(method);
 };
 await assert.rejects(readBscDepositEvidence({rpc,transactionHash:tx,expected}),/transaction changed/);
});

test("rejects missing transaction index on either side of RPC provenance",async()=>{
 const variants=[
  {receipt:{...receipt,transactionIndex:"0x2"},transaction:{hash:tx,blockHash:hash,blockNumber:"0x64"}},
  {receipt,transaction:{hash:tx,blockHash:hash,blockNumber:"0x64",transactionIndex:"0x2"}}
 ];
 for(const v of variants){
  const rpc=makeRpc({eth_getTransactionReceipt:v.receipt,eth_getTransactionByHash:v.transaction});
  await assert.rejects(readBscDepositEvidence({rpc,transactionHash:tx,expected}),/provenance/);
 }
});
