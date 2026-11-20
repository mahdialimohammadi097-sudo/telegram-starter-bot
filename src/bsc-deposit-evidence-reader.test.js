import test from "node:test";
import assert from "node:assert/strict";
import { createBscDepositEvidenceReader } from "./bsc-deposit-evidence-reader.js";
const a="0x"+"a".repeat(40),b="0x"+"b".repeat(40),c="0x"+"c".repeat(40),tx="0x"+"d".repeat(64),bh="0x"+"e".repeat(64);
const topic="0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const t=x=>"0x"+x.slice(2).padStart(64,"0");
const receipt={transactionHash:tx,blockHash:bh,blockNumber:"0x6d",status:"0x1",logs:[{address:a,topics:[topic,t(c),t(b)],data:"0x"+(10n**18n).toString(16).padStart(64,"0"),transactionHash:tx,blockHash:bh,blockNumber:"0x6d",logIndex:"0x0",removed:false}]};
const policy={chainId:56,tokenContract:a,depositAddress:b,tokenDecimals:18,minConfirmations:12};
function reader(overrides={}) {
 const calls=[];
 const values={eth_chainId:"0x38",eth_getTransactionReceipt:receipt,eth_getBlockByNumber:{hash:bh,number:"0x6d"},eth_blockNumber:"0x78",...overrides};
 const fetchImpl=async(_url,options)=>{const q=JSON.parse(options.body);calls.push(q.method);return {ok:true,json:async()=>({jsonrpc:"2.0",id:q.id,result:values[q.method]})}};
 return {inspect:createBscDepositEvidenceReader({rpcUrl:"https://rpc.example.org",fetchImpl}),calls};
}
test("reads chain, receipt, canonical block and head before accepting deposit evidence",async()=>{
 const {inspect,calls}=reader();assert.equal((await inspect(tx,"0x0",policy)).eventKey,"bsc:56:"+tx+":0");
 assert.deepEqual(calls,["eth_chainId","eth_getTransactionReceipt","eth_getBlockByNumber","eth_blockNumber","eth_getTransactionReceipt"]);
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
  const values={eth_chainId:"0x38",eth_getBlockByNumber:{hash:bh,number:"0x6d"},eth_blockNumber:"0x78"};
  const result=q.method==="eth_getTransactionReceipt"?(++reads===1?receipt:{...receipt,blockHash:tx}):values[q.method];
  return {ok:true,json:async()=>({jsonrpc:"2.0",id:q.id,result})};
 };
 const inspect=createBscDepositEvidenceReader({rpcUrl:"https://rpc.example.org",fetchImpl});
 await assert.rejects(inspect(tx,"0x0",policy),/changed during inspection/);
});
