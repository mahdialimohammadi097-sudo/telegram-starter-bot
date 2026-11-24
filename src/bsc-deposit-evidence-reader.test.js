import test from "node:test";
import assert from "node:assert/strict";
import { createBscDepositEvidenceReader } from "./bsc-deposit-evidence-reader.js";
const a="0x"+"a".repeat(40),b="0x"+"b".repeat(40),c="0x"+"c".repeat(40),tx="0x"+"d".repeat(64),bh="0x"+"e".repeat(64);
const topic="0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const t=x=>"0x"+x.slice(2).padStart(64,"0");
const receipt={transactionHash:tx,blockHash:bh,blockNumber:"0x6d",status:"0x1",logs:[{address:a,topics:[topic,t(c),t(b)],data:"0x"+(10n**18n).toString(16).padStart(64,"0"),transactionHash:tx,blockHash:bh,blockNumber:"0x6d",logIndex:"0x0",removed:false}]};
const transaction={hash:tx,blockHash:bh,blockNumber:"0x6d"};
const policy={chainId:56,tokenContract:a,depositAddress:b,tokenDecimals:18,minConfirmations:12};
function reader(overrides={}) {
 const calls=[];
 const values={eth_getTransactionByHash:transaction,eth_chainId:"0x38",eth_getTransactionReceipt:receipt,eth_getBlockByNumber:{hash:bh,number:"0x6d"},eth_blockNumber:"0x78",...overrides};
 const fetchImpl=async(_url,options)=>{const q=JSON.parse(options.body);calls.push(q.method);return {ok:true,json:async()=>({jsonrpc:"2.0",id:q.id,result:values[q.method]})}};
 return {inspect:createBscDepositEvidenceReader({rpcUrl:"https://rpc.example.org",fetchImpl}),calls};
}
test("reads chain, receipt, canonical block and head before accepting deposit evidence",async()=>{
 const {inspect,calls}=reader();const evidence = await inspect(tx,"0x0",policy);
 assert.equal(evidence.eventKey,"bsc:56:"+tx+":0");
 assert.equal(evidence.ledgerAmount,"1.00000000");
 assert.deepEqual(calls,["eth_chainId","eth_getTransactionReceipt","eth_getTransactionByHash","eth_getBlockByNumber","eth_blockNumber","eth_getTransactionReceipt","eth_getTransactionByHash","eth_chainId","eth_blockNumber","eth_getBlockByNumber"]);
});
test("rejects wrong chain and inconsistent canonical block",async()=>{
 await assert.rejects(reader({eth_chainId:"0x1"}).inspect(tx,"0x0",policy));
 await assert.rejects(reader({eth_getBlockByNumber:{hash:tx,number:"0x6d"}}).inspect(tx,"0x0",policy));
});
test("rejects insufficient confirmations and malformed RPC endpoint",async()=>{
 await assert.rejects(reader({eth_blockNumber:"0x6e"}).inspect(tx,"0x0",policy));
 assert.throws(()=>createBscDepositEvidenceReader({rpcUrl:"http://rpc.example.org"}));
});

test("rejects receipt reorganization during RPC inspection",async()=>{
 let reads=0;
 const fetchImpl=async(_url,options)=>{
  const q=JSON.parse(options.body);
  const values={eth_getTransactionByHash:transaction,eth_chainId:"0x38",eth_getBlockByNumber:{hash:bh,number:"0x6d"},eth_blockNumber:"0x78"};
  const result=q.method==="eth_getTransactionReceipt"?(++reads===1?receipt:{...receipt,blockHash:tx}):values[q.method];
  return {ok:true,json:async()=>({jsonrpc:"2.0",id:q.id,result})};
 };
 const inspect=createBscDepositEvidenceReader({rpcUrl:"https://rpc.example.org",fetchImpl});
 await assert.rejects(inspect(tx,"0x0",policy),/changed during inspection/);
});

test("rejects BSC receipt amounts that cannot be posted without rounding",async()=>{
 const dustReceipt={...receipt,logs:[{...receipt.logs[0],data:"0x"+(10n**18n+1n).toString(16).padStart(64,"0")}]};
 await assert.rejects(reader({eth_getTransactionReceipt:dustReceipt}).inspect(tx,"0x0",policy),/manual review required/);
});

test("rejects changed canonical block after the second receipt",async()=>{
 let blocks=0;
 const values={eth_getTransactionByHash:transaction,eth_chainId:"0x38",eth_getTransactionReceipt:receipt,eth_blockNumber:"0x78"};
 const inspect=createBscDepositEvidenceReader({rpcUrl:"https://rpc.example.org",fetchImpl:async(_url,options)=>{
  const q=JSON.parse(options.body);
  const result=q.method==="eth_getBlockByNumber"?{hash:++blocks===1?bh:tx,number:"0x6d"}:values[q.method];
  return {ok:true,json:async()=>({jsonrpc:"2.0",id:q.id,result})};
 }});
 await assert.rejects(inspect(tx,"0x0",policy),/Canonical block changed/);
});
test("snapshots trusted configuration before asynchronous RPC",async()=>{
 const mutable={...policy};
 const values={eth_getTransactionByHash:transaction,eth_chainId:"0x38",eth_getTransactionReceipt:receipt,eth_getBlockByNumber:{hash:bh,number:"0x6d"},eth_blockNumber:"0x78"};
 const inspect=createBscDepositEvidenceReader({rpcUrl:"https://rpc.example.org",fetchImpl:async(_url,options)=>{
  const q=JSON.parse(options.body);
  mutable.depositAddress=c;
  return {ok:true,json:async()=>({jsonrpc:"2.0",id:q.id,result:values[q.method]})};
 }});
 assert.equal((await inspect(tx,"0x0",mutable)).depositAddress,b);
});
test("does not expose transport or parser errors and rejects oversized index",async()=>{
 const inspect=createBscDepositEvidenceReader({rpcUrl:"https://rpc.example.org",fetchImpl:async()=>{throw Error("synthetic private endpoint detail")}});
 await assert.rejects(inspect(tx,"0x0",policy),{message:"BSC RPC request failed"});
 await assert.rejects(inspect(tx,"0x"+"f".repeat(65),policy),/Invalid log index/);
});

test("rejects changes to transfer amount even when both receipt headers match",async()=>{
 let reads=0;
 const values={eth_getTransactionByHash:transaction,eth_chainId:"0x38",eth_getBlockByNumber:{hash:bh,number:"0x6d"},eth_blockNumber:"0x78"};
 const inspect=createBscDepositEvidenceReader({rpcUrl:"https://rpc.example.org",fetchImpl:async(_url,options)=>{
  const q=JSON.parse(options.body);
  const result=q.method==="eth_getTransactionReceipt"?(++reads===1?receipt:{...receipt,logs:[{...receipt.logs[0],data:"0x"+(2n*10n**18n).toString(16).padStart(64,"0")}]}):values[q.method];
  return {ok:true,json:async()=>({jsonrpc:"2.0",id:q.id,result})};
 }});
 await assert.rejects(inspect(tx,"0x0",policy),/Transfer evidence changed/);
});
test("rejects a mutable receipt reused by an RPC adapter",async()=>{
 const mutable=structuredClone(receipt);
 let reads=0;
 const values={eth_getTransactionByHash:transaction,eth_chainId:"0x38",eth_getBlockByNumber:{hash:bh,number:"0x6d"},eth_blockNumber:"0x78"};
 const inspect=createBscDepositEvidenceReader({rpcUrl:"https://rpc.example.org",fetchImpl:async(_url,options)=>{
  const q=JSON.parse(options.body);
  if(q.method==="eth_getTransactionReceipt" && ++reads===2) mutable.logs[0].data="0x"+(2n*10n**18n).toString(16).padStart(64,"0");
  return {ok:true,json:async()=>({jsonrpc:"2.0",id:q.id,result:q.method==="eth_getTransactionReceipt"?mutable:values[q.method]})};
 }});
 await assert.rejects(inspect(tx,"0x0",policy),/Transfer evidence changed/);
});

test("rejects inconsistent repeated transaction, chain and head responses",async()=>{
 for(const [method,changed,error] of [
  ["eth_getTransactionByHash",{...transaction,blockHash:tx},/provenance mismatch/],
  ["eth_chainId","0x1",/chain changed/],
  ["eth_blockNumber","0x77",/head changed or regressed/]
 ]){
  const values={eth_chainId:"0x38",eth_getTransactionReceipt:receipt,eth_getTransactionByHash:transaction,eth_getBlockByNumber:{hash:bh,number:"0x6d"},eth_blockNumber:"0x78"};
  let reads=0;
  const inspect=createBscDepositEvidenceReader({rpcUrl:"https://rpc.example.org",fetchImpl:async(_url,options)=>{
   const q=JSON.parse(options.body);
   const result=q.method===method && ++reads===2?changed:values[q.method];
   return {ok:true,json:async()=>({jsonrpc:"2.0",id:q.id,result})};
  }});
  await assert.rejects(inspect(tx,"0x0",policy),error);
 }
});
test("rejects inconsistent first transaction provenance",async()=>{
 for(const changed of [{...transaction,hash:bh},{...transaction,blockNumber:"0x6e"},{...transaction,transactionIndex:"0x0"}]){
  await assert.rejects(reader({eth_getTransactionByHash:changed}).inspect(tx,"0x0",policy),/provenance mismatch/);
 }
});
test("zero configured addresses fail before contacting RPC",async()=>{
 const zero="0x"+"0".repeat(40);
 const {inspect,calls}=reader();
 for(const changed of [{depositAddress:zero},{tokenContract:zero}]) await assert.rejects(inspect(tx,"0x0",{...policy,...changed}),/address configuration/);
 assert.deepEqual(calls,[]);
});
