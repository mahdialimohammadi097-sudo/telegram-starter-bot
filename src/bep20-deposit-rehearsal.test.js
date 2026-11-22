import test from "node:test";
import assert from "node:assert/strict";
import {rehearseVerifiedBep20Deposit} from "./bep20-deposit-rehearsal.js";
const tokenContract="0x"+"a".repeat(40), depositAddress="0x"+"b".repeat(40);
const txHash="0x"+"c".repeat(64), hash="0x"+"d".repeat(64);
const block={hash,number:"0x64"}, transaction={hash:txHash,blockHash:hash,blockNumber:"0x64"};
const log={address:tokenContract,topics:["0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef","0x"+"0".repeat(24)+"e".repeat(40),"0x"+"0".repeat(24)+"b".repeat(40)],data:"0x"+"0".repeat(48)+"0de0b6b3a7640000",logIndex:"0x0",transactionHash:txHash,blockHash:hash};
const receipt={transactionHash:txHash,blockHash:hash,blockNumber:"0x64",status:"0x1",logs:[log]};
const base={receipt,transaction,block,head:"0x77",tokenContract,depositAddress};
const pool={connect(){throw Error("unexpected database access")}};
test("reject insufficient confirmations before database access",async()=>{
 await assert.rejects(rehearseVerifiedBep20Deposit({...base,pool,head:"0x76"}),/Insufficient confirmations/);
});
test("reject duplicate destination transfers before database access",async()=>{
 await assert.rejects(rehearseVerifiedBep20Deposit({...base,pool,receipt:{...receipt,logs:[log,{...log,logIndex:"0x1"}]}}),/durable event processing/);
});
test("reject nonrepresentable token precision before database access",async()=>{
 const fractional={...log,data:"0x"+"0".repeat(63)+"1"};
 await assert.rejects(rehearseVerifiedBep20Deposit({...base,pool,receipt:{...receipt,logs:[fractional]}}),/precision/);
});
test("reject missing ownership adapter after receipt verification",async()=>{
 await assert.rejects(rehearseVerifiedBep20Deposit({...base,pool,clearingAccountId:"1"}),/adapter/);
});
