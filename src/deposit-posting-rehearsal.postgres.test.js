import test from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import {rehearseVerifiedDepositPosting} from "./deposit-posting-rehearsal.js";
const url=process.env.DATABASE_URL;
function safe(){try{const u=new URL(url);return process.env.PROFINO_DISPOSABLE_POSTGRES==="yes"&&["localhost","127.0.0.1","::1"].includes(u.hostname)&&u.pathname==="/profino_test";}catch{return false;}}
test("rehearsal rolls back inserted evidence if journal construction fails",{skip:!safe()},async()=>{
 const pool=new pg.Pool({connectionString:url,max:1});
 const evidence={chainId:56,transactionHash:"0x"+"a".repeat(64),logIndex:1,
  blockHash:"0x"+"b".repeat(64),blockNumber:"100",tokenContract:"0x"+"c".repeat(40),
  depositAddress:"0x"+"d".repeat(40),amountBaseUnits:"1000000000000000000"};
 const key="bsc:56:"+evidence.transactionHash+":1";
 try{
  // TEMP table is session-local; max:1 keeps rehearsal and verification on one connection.
  await pool.query(`CREATE TEMP TABLE verified_deposit_evidence (
   event_key text PRIMARY KEY,block_hash text NOT NULL,block_number numeric(78,0) NOT NULL,
   token_contract text NOT NULL,deposit_address text NOT NULL,amount_base_units numeric(78,0) NOT NULL)`);
  await assert.rejects(rehearseVerifiedDepositPosting({pool,evidence,tokenDecimals:18,
   journalForUnits:()=>{throw new Error("forced journal failure");}}),/forced journal failure/);
  const result=await pool.query("SELECT count(*)::int AS count FROM pg_temp.verified_deposit_evidence WHERE event_key=$1",[key]);
  assert.equal(result.rows[0].count,0);
 }finally{await pool.end();}
});

test("replayed evidence fails before any journal construction",{skip:!safe()},async()=>{
 const pool=new pg.Pool({connectionString:url,max:1});
 const evidence={chainId:56,transactionHash:"0x"+"e".repeat(64),logIndex:4,
  blockHash:"0x"+"b".repeat(64),blockNumber:"100",tokenContract:"0x"+"c".repeat(40),
  depositAddress:"0x"+"d".repeat(40),amountBaseUnits:"1000000000000000000"};
 const key="bsc:56:"+evidence.transactionHash+":4";
 let journalCalled=false;
 try{
  await pool.query(`CREATE TEMP TABLE verified_deposit_evidence (
   event_key text PRIMARY KEY,block_hash text NOT NULL,block_number numeric(78,0) NOT NULL,
   token_contract text NOT NULL,deposit_address text NOT NULL,amount_base_units numeric(78,0) NOT NULL)`);
  await pool.query(`INSERT INTO pg_temp.verified_deposit_evidence
   (event_key,block_hash,block_number,token_contract,deposit_address,amount_base_units)
   VALUES ($1,$2,$3,$4,$5,$6)`,
   [key,evidence.blockHash,evidence.blockNumber,evidence.tokenContract,evidence.depositAddress,evidence.amountBaseUnits]);
  await assert.rejects(rehearseVerifiedDepositPosting({pool,evidence,tokenDecimals:18,
   journalForUnits:()=>{journalCalled=true;throw new Error("should never build journal");}}),/duplicate key/);
  assert.equal(journalCalled,false);
  const result=await pool.query("SELECT count(*)::int AS count FROM pg_temp.verified_deposit_evidence WHERE event_key=$1",[key]);
  assert.equal(result.rows[0].count,1);
 }finally{await pool.end();}
});
