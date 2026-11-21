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
