import test from "node:test";
import assert from "node:assert/strict";
import {prepareBscDepositJournal as prepare} from "./bsc-deposit-journal-preparation.js";
const tx="0x"+"a".repeat(64),blockHash="0x"+"b".repeat(64);
const token="0x"+"c".repeat(40),address="0x"+"d".repeat(40);
const topic="0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const log={logIndex:"0x2",address:token,transactionHash:tx,blockHash,blockNumber:"0x64",
 topics:[topic,"0x"+"0".repeat(24)+"e".repeat(40),"0x"+"0".repeat(24)+address.slice(2)],
 data:"0x"+(125n*10n**16n).toString(16).padStart(64,"0")};
const receipt={transactionHash:tx,blockHash,blockNumber:"0x64",status:"0x1",logs:[log]};
const rpc=async method=>({
 eth_chainId:"0x38",eth_getTransactionReceipt:receipt,
 eth_getTransactionByHash:{hash:tx,blockHash,blockNumber:"0x64"},
 eth_getBlockByNumber:{hash:blockHash,number:"0x64"},eth_blockNumber:"0x78"
})[method];
const row={wallet_id:"3",user_id:"12",chain_id:"56",wallet_address:address,start_block:"50",end_block:null,
 wallet_id_current:"3",wallet_chain_id:"56",wallet_address_current:address,is_platform_controlled:true};
const expected={transactionHash:tx,tokenContract:token,depositAddress:address,logIndex:2,tokenDecimals:18,minConfirmations:12};
const base={rpc,transactionHash:tx,expected,expectedUserId:"12",
 userAccount:{id:"4",user_id:"12",account_type:"AVAILABLE",currency:"USDT"},
 clearingAccount:{id:"5",user_id:null,account_type:"CLEARING",currency:"USDT"}};
test("prepares a deterministic balanced journal after historical ownership inspection",async()=>{
 let calls=0;
 const client={query:async()=>{calls++;return {rows:[row],rowCount:1}}};
 const result=await prepare({...base,client});
 assert.equal(calls,1);
 assert.equal(result.evidence.userId,"12");
 assert.equal(result.journal.idempotencyKey,"deposit:"+result.evidence.eventKey);
 assert.deepEqual(result.journal.entries.map(e=>e.amount),["1.25000000","1.25000000"]);
 assert.ok(Object.isFrozen(result));
});
test("does not produce journal when historical ownership is rejected",async()=>{
 const client={query:async()=>({rows:[{...row,user_id:"13"}],rowCount:1})};
 await assert.rejects(prepare({...base,client}),/identity mismatch/);
});
test("does not produce journal when account identities are invalid",async()=>{
 const client={query:async()=>({rows:[row],rowCount:1})};
 await assert.rejects(prepare({...base,client,userAccount:{...base.userAccount,id:"5"}}),/journal proposal/);
});
test("rejects wrong network before any database inspection",async()=>{
 let calls=0;
 const client={query:async()=>{calls++;return {rows:[row],rowCount:1}}};
 await assert.rejects(prepare({...base,client,rpc:async method=>method==="eth_chainId"?"0x61":rpc(method)}));
 assert.equal(calls,0);
});

test("rejects cross-user, wrong-currency and non-clearing ledger accounts",async()=>{
 const client={query:async()=>({rows:[row],rowCount:1})};
 for(const patch of [
  {userAccount:{...base.userAccount,user_id:"13"}},
  {userAccount:{...base.userAccount,currency:"BTC"}},
  {userAccount:{...base.userAccount,account_type:"INVESTED"}},
  {clearingAccount:{...base.clearingAccount,user_id:"12"}},
  {clearingAccount:{...base.clearingAccount,account_type:"AVAILABLE"}}
 ]){
  await assert.rejects(prepare({...base,...patch,client}),/account identity mismatch/);
 }
});
