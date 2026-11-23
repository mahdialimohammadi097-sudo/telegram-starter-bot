import test from "node:test";
import assert from "node:assert/strict";
import {inspectBscDepositWithHistoricalOwner as inspect} from "./bsc-deposit-ownership-preflight.js";
const tx="0x"+"a".repeat(64),hash="0x"+"b".repeat(64),token="0x"+"c".repeat(40),to="0x"+"d".repeat(40);
const topic="0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const log={logIndex:"0x2",address:token,transactionHash:tx,blockHash:hash,blockNumber:"0x64",topics:[topic,"0x"+"0".repeat(24)+"e".repeat(40),"0x"+"0".repeat(24)+to.slice(2)],data:"0x"+(10n**18n).toString(16).padStart(64,"0")};
const receipt={transactionHash:tx,blockHash:hash,blockNumber:"0x64",status:"0x1",logs:[log]};
const expected={transactionHash:tx,tokenContract:token,depositAddress:to,logIndex:2,tokenDecimals:18,minConfirmations:12};
const rpc=async(method)=>({
 eth_chainId:"0x38",eth_getTransactionReceipt:receipt,
 eth_getTransactionByHash:{hash:tx,blockHash:hash,blockNumber:"0x64"},
 eth_getBlockByNumber:{hash,number:"0x64"},eth_blockNumber:"0x78"
})[method];
const row={wallet_id:"1",user_id:"12",chain_id:"56",wallet_address:to,start_block:"50",end_block:null,wallet_id_current:"1",wallet_chain_id:"56",wallet_address_current:to,is_platform_controlled:true};
test("combines read-only chain and historical wallet checks without ledger writes",async()=>{
 let queries=0;
 const client={query:async(sql,params)=>{
  queries++;assert.match(sql,/FOR SHARE OF h,w/);assert.deepEqual(params,[to,"100"]);
  return {rows:[row],rowCount:1};
 }};
 const result=await inspect({rpc,client,transactionHash:tx,expected,expectedUserId:"12"});
 assert.equal(result.walletId,"1");
 assert.equal(result.userId,"12");
 assert.equal(result.units,"100000000");
 assert.equal(queries,1);
 assert.ok(Object.isFrozen(result));
});
test("rejects wrong historical owner even with valid chain evidence",async()=>{
 const client={query:async()=>({rows:[{...row,user_id:"13"}],rowCount:1})};
 await assert.rejects(inspect({rpc,client,transactionHash:tx,expected,expectedUserId:"12"}));
});
test("rejects invalid chain evidence before any database lookup",async()=>{
 let queries=0;
 const client={query:async()=>{queries++;return {rows:[row]}}};
 await assert.rejects(inspect({rpc:async(method)=>method==="eth_chainId"?"0x61":rpc(method),client,transactionHash:tx,expected,expectedUserId:"12"}));
 assert.equal(queries,0);
});

test("rejects missing or ambiguous historical ownership without crediting",async()=>{
 for(const rows of [[],[row,{...row,wallet_id:"2",wallet_id_current:"2"}]]){
  const client={query:async()=>({rows,rowCount:rows.length})};
  await assert.rejects(inspect({rpc,client,transactionHash:tx,expected,expectedUserId:"12"}),/Missing or ambiguous/);
 }
});
test("rejects a wallet not controlled by the platform",async()=>{
 const client={query:async()=>({rows:[{...row,is_platform_controlled:false}],rowCount:1})};
 await assert.rejects(inspect({rpc,client,transactionHash:tx,expected,expectedUserId:"12"}),/identity mismatch/);
});
test("rejects a historical ownership interval that excludes the transfer block",async()=>{
 for(const interval of [{start_block:"101"},{end_block:"100"},{start_block:"100",end_block:"100"}]){
  const client={query:async()=>({rows:[{...row,...interval}],rowCount:1})};
  await assert.rejects(inspect({rpc,client,transactionHash:tx,expected,expectedUserId:"12"}),/interval mismatch/);
 }
});
