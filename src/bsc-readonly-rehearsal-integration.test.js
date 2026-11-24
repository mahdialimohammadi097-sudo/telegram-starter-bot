import test from "node:test";
import assert from "node:assert/strict";
import {rehearseBscDepositJournal} from "./bsc-deposit-readonly-rehearsal.js";

const tx="0x"+"a".repeat(64),block="0x"+"b".repeat(64);
const token="0x"+"c".repeat(40),address="0x"+"d".repeat(40);
const topic="0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const log={logIndex:"0x2",address:token,transactionHash:tx,blockHash:block,blockNumber:"0x64",
 topics:[topic,"0x"+"0".repeat(24)+"e".repeat(40),"0x"+"0".repeat(24)+address.slice(2)],
 data:"0x"+(10n*10n**18n).toString(16).padStart(64,"0")};
const receipt={transactionHash:tx,blockHash:block,blockNumber:"0x64",status:"0x1",logs:[log]};
const rpc=async method=>({
 eth_chainId:"0x38",eth_getTransactionReceipt:receipt,
 eth_getTransactionByHash:{hash:tx,blockHash:block,blockNumber:"0x64"},
 eth_getBlockByNumber:{hash:block,number:"0x64"},eth_blockNumber:"0x78"
})[method];
const input={rpc,transactionHash:tx,expected:{
 transactionHash:tx,tokenContract:token,depositAddress:address,
 logIndex:2,tokenDecimals:18,minConfirmations:12
},expectedUserId:"12",userAvailableAccountId:"4",platformClearingAccountId:"5"};
const history={wallet_id:"3",user_id:"12",chain_id:"56",wallet_address:address,
 start_block:"50",end_block:null,wallet_id_current:"3",wallet_chain_id:"56",
 wallet_address_current:address,is_platform_controlled:true};
const accounts=[{id:"4",user_id:"12",account_type:"AVAILABLE",currency:"USDT"},
 {id:"5",user_id:null,account_type:"CLEARING",currency:"USDT"}];
function mockClient({duplicate=false,ledgerDuplicate=false,failAt=null}={}){
 const statements=[];
 const client={query:async(sql,params)=>{
  statements.push({sql,params});
  if(failAt && sql.includes(failAt))throw new Error("simulated query failure");
  if(sql.includes("deposit_address_ownership_history"))return {rows:[history],rowCount:1};
  if(sql.includes("ledger_accounts"))return {rows:accounts,rowCount:2};
  if(sql.includes("verified_deposit_evidence"))return {rows:[{
   evidence_exists:duplicate,ledger_exists:ledgerDuplicate
  }],rowCount:1};
  if(sql==="BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY" ||
     sql.startsWith("SET LOCAL") || sql==="ROLLBACK")return {rows:[]};
  throw new Error("Unexpected SQL");
 }};
 return {client,statements};
}
test("full 10 USDT rehearsal only reads and always rolls back",async()=>{
 const {client,statements}=mockClient();
 const result=await rehearseBscDepositJournal({client,...input});
 assert.equal(result.evidence.units,"1000000000");
 assert.equal(result.journal.idempotencyKey,"deposit:"+result.evidence.eventKey);
 assert.equal(statements[0].sql,"BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
 assert.equal(statements.at(-1).sql,"ROLLBACK");
 assert.equal(statements.filter(s=>s.sql.trim().startsWith("SELECT")).length,3);
 assert.ok(statements.every(s=>/^(BEGIN|SET LOCAL|SELECT|ROLLBACK)/.test(s.sql.trim())));
 assert.ok(statements.every(s=>!s.sql.includes("FOR SHARE")));
});
test("recorded event fails closed and rehearsal rolls back",async()=>{
 const {client,statements}=mockClient({duplicate:true});
 await assert.rejects(rehearseBscDepositJournal({client,...input}),/already recorded/);
 assert.equal(statements.at(-1).sql,"ROLLBACK");
 assert.ok(statements.every(s=>!s.sql.includes("COMMIT")));
});
test("database read failure rolls back without returning a journal",async()=>{
 const {client,statements}=mockClient({failAt:"ledger_accounts"});
 await assert.rejects(rehearseBscDepositJournal({client,...input}),/simulated query failure/);
 assert.equal(statements.at(-1).sql,"ROLLBACK");
});

test("ledger-only duplicate event blocks rehearsal even without evidence row",async()=>{
 const {client,statements}=mockClient({ledgerDuplicate:true});
 await assert.rejects(rehearseBscDepositJournal({client,...input}),/already recorded/);
 assert.equal(statements.at(-1).sql,"ROLLBACK");
 assert.ok(statements.every(s=>!s.sql.includes("COMMIT")));
});
test("idempotency lookup failure rolls back and never returns a proposal",async()=>{
 const {client,statements}=mockClient({failAt:"verified_deposit_evidence"});
 await assert.rejects(rehearseBscDepositJournal({client,...input}),/simulated query failure/);
 assert.equal(statements.at(-1).sql,"ROLLBACK");
 assert.ok(statements.every(s=>!s.sql.includes("COMMIT")));
});
