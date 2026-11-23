import test from "node:test";
import assert from "node:assert/strict";
import {rehearseVerifiedDepositPosting} from "./deposit-posting-rehearsal.js";
const evidence={chainId:56,transactionHash:"0x"+"a".repeat(64),logIndex:0,
 blockHash:"0x"+"b".repeat(64),blockNumber:"100",
 tokenContract:"0x"+"c".repeat(40),depositAddress:"0x"+"d".repeat(40),
 amountBaseUnits:"1000000000000000000"};
const env=process.env.PROFINO_DISPOSABLE_POSTGRES;
const url=process.env.DATABASE_URL;
test("rehearsal fails closed before opening a transaction without disposable mode",async()=>{
 try{
  delete process.env.PROFINO_DISPOSABLE_POSTGRES;
  const pool={connect(){throw new Error("must not connect");}};
  await assert.rejects(rehearseVerifiedDepositPosting({pool,evidence,tokenDecimals:18,journalForUnits:()=>({})}),/Disposable PostgreSQL test mode required/);
 }finally{
  if(env===undefined)delete process.env.PROFINO_DISPOSABLE_POSTGRES;
  else process.env.PROFINO_DISPOSABLE_POSTGRES=env;
 }
});
test("rehearsal rejects malformed evidence and lossy amounts before connecting",async()=>{
 const pool={connect(){throw new Error("must not connect");}};
 await assert.rejects(rehearseVerifiedDepositPosting({pool,evidence:{...evidence,blockHash:"bad"},tokenDecimals:18,journalForUnits:()=>({})}),/Invalid evidence/);
 await assert.rejects(rehearseVerifiedDepositPosting({pool,evidence:{...evidence,amountBaseUnits:"1000000000000000001"},tokenDecimals:18,journalForUnits:()=>({})}),/exactly/);
});
