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
  await pool.query(`CREATE TEMP TABLE ledger_accounts (
   id bigint PRIMARY KEY,user_id bigint,account_type text,currency text)`);
  await pool.query("INSERT INTO pg_temp.ledger_accounts VALUES (44,12,'AVAILABLE','USDT')");
  await assert.rejects(rehearseVerifiedDepositPosting({pool,evidence,tokenDecimals:18,
   destinationOwner:{accountId:"44",userId:"12"},
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

test("concurrent duplicate evidence inserts permit exactly one committed event",{skip:!safe()},async()=>{
 const pool=new pg.Pool({connectionString:url,max:3});
 const schema="replay_"+(await import("node:crypto")).randomUUID().replaceAll("-","");
 const eventKey="bsc:56:0x"+"f".repeat(64)+":7";
 try{
  await pool.query('CREATE SCHEMA "'+schema+'"');
  await pool.query('CREATE TABLE "'+schema+'".verified_deposit_evidence (event_key text PRIMARY KEY, amount_base_units numeric(78,0) NOT NULL)');
  const attempt=async()=>{
   const client=await pool.connect();
   try{
    await client.query("BEGIN");
    await client.query('INSERT INTO "'+schema+'".verified_deposit_evidence (event_key,amount_base_units) VALUES ($1,$2)',[eventKey,"1000000000000000000"]);
    await client.query("COMMIT");
    return "committed";
   }catch(error){
    await client.query("ROLLBACK");
    if(error.code==="23505")return "duplicate";
    throw error;
   }finally{client.release();}
  };
  const outcomes=await Promise.all([attempt(),attempt()]);
  assert.deepEqual(outcomes.sort(),["committed","duplicate"]);
  const result=await pool.query('SELECT count(*)::int AS count FROM "'+schema+'".verified_deposit_evidence WHERE event_key=$1',[eventKey]);
  assert.equal(result.rows[0].count,1);
 }finally{
  await pool.query('DROP SCHEMA IF EXISTS "'+schema+'" CASCADE');
  await pool.end();
 }
});

test("destination ownership mismatch rolls back evidence in the same transaction",{skip:!safe()},async()=>{
 const pool=new pg.Pool({connectionString:url,max:1});
 const evidence={chainId:56,transactionHash:"0x"+"8".repeat(64),logIndex:8,
  blockHash:"0x"+"b".repeat(64),blockNumber:"100",tokenContract:"0x"+"c".repeat(40),
  depositAddress:"0x"+"d".repeat(40),amountBaseUnits:"1000000000000000000"};
 const key="bsc:56:"+evidence.transactionHash+":8";
 let journalCalled=false;
 try{
  await pool.query(`CREATE TEMP TABLE verified_deposit_evidence (
   event_key text PRIMARY KEY,block_hash text NOT NULL,block_number numeric(78,0) NOT NULL,
   token_contract text NOT NULL,deposit_address text NOT NULL,amount_base_units numeric(78,0) NOT NULL)`);
  await pool.query(`CREATE TEMP TABLE ledger_accounts (
   id bigint PRIMARY KEY,user_id bigint,account_type text,currency text)`);
  await pool.query("INSERT INTO pg_temp.ledger_accounts VALUES (44,13,'AVAILABLE','USDT')");
  await assert.rejects(rehearseVerifiedDepositPosting({pool,evidence,tokenDecimals:18,
   destinationOwner:{accountId:"44",userId:"12"},
   journalForUnits:()=>{journalCalled=true;throw new Error("must not build journal");}}),/ownership is unverified/);
  assert.equal(journalCalled,false);
  const result=await pool.query("SELECT count(*)::int AS count FROM pg_temp.verified_deposit_evidence WHERE event_key=$1",[key]);
  assert.equal(result.rows[0].count,0);
 }finally{await pool.end();}
});

test("wrong credit account rolls back evidence even when destination owner is valid",{skip:!safe()},async()=>{
 const pool=new pg.Pool({connectionString:url,max:1});
 const evidence={chainId:56,transactionHash:"0x"+"9".repeat(64),logIndex:9,
  blockHash:"0x"+"b".repeat(64),blockNumber:"100",tokenContract:"0x"+"c".repeat(40),
  depositAddress:"0x"+"d".repeat(40),amountBaseUnits:"1000000000000000000"};
 const key="bsc:56:"+evidence.transactionHash+":9";
 try{
  await pool.query(`CREATE TEMP TABLE verified_deposit_evidence (
   event_key text PRIMARY KEY,block_hash text NOT NULL,block_number numeric(78,0) NOT NULL,
   token_contract text NOT NULL,deposit_address text NOT NULL,amount_base_units numeric(78,0) NOT NULL)`);
  await pool.query(`CREATE TEMP TABLE ledger_accounts (
   id bigint PRIMARY KEY,user_id bigint,account_type text,currency text)`);
  await pool.query("INSERT INTO pg_temp.ledger_accounts VALUES (44,12,'AVAILABLE','USDT')");
  await assert.rejects(rehearseVerifiedDepositPosting({pool,evidence,tokenDecimals:18,
   destinationOwner:{accountId:"44",userId:"12"},
   journalForUnits:({eventKey})=>({
    idempotencyKey:`verified-deposit:${eventKey}`,
    entries:[{account_id:"1",entry_type:"debit",amount:"1",currency:"USDT"},
             {account_id:"45",entry_type:"credit",amount:"1",currency:"USDT"}]
   })}),/credit must target locked customer account/);
  const result=await pool.query("SELECT count(*)::int AS count FROM pg_temp.verified_deposit_evidence WHERE event_key=$1",[key]);
  assert.equal(result.rows[0].count,0);
 }finally{await pool.end();}
});

test("valid owner posts exactly one balanced deposit journal and evidence atomically",{skip:!safe()},async()=>{
 const {randomUUID}=await import("node:crypto");
 const {readFile}=await import("node:fs/promises");
 const schema="deposit_ok_"+randomUUID().replaceAll("-","");
 const admin=new pg.Pool({connectionString:url});
 let pool;
 try{
  await admin.query('CREATE SCHEMA "'+schema+'"');
  pool=new pg.Pool({connectionString:url,options:"-c search_path="+schema,max:1});
  await pool.query(await readFile(new URL("../test/fixtures/ledger-contract.sql",import.meta.url),"utf8"));
  await pool.query(`CREATE TABLE verified_deposit_evidence (
   event_key text PRIMARY KEY,block_hash text NOT NULL,block_number numeric(78,0) NOT NULL,
   token_contract text NOT NULL,deposit_address text NOT NULL,amount_base_units numeric(78,0) NOT NULL)`);
  await pool.query("INSERT INTO users(id) VALUES (12)");
  await pool.query("INSERT INTO ledger_accounts(id,user_id,account_code,account_type,currency) VALUES (44,12,'customer-12','AVAILABLE','USDT'),(45,NULL,'deposit-clearing','CLEARING','USDT')");
  const evidence={chainId:56,transactionHash:"0x"+"7".repeat(64),logIndex:7,
   blockHash:"0x"+"b".repeat(64),blockNumber:"100",tokenContract:"0x"+"c".repeat(40),
   depositAddress:"0x"+"d".repeat(40),amountBaseUnits:"1000000000000000000"};
  const eventKey="bsc:56:"+evidence.transactionHash+":7";
  await assert.rejects(rehearseVerifiedDepositPosting({pool,evidence,tokenDecimals:18,
   destinationOwner:{accountId:"44",userId:"12"},
   journalForUnits:({eventKey})=>({
    transactionType:"withdrawal",idempotencyKey:"verified-deposit:"+eventKey,
    entries:[{account_id:"45",entry_type:"debit",amount:"1",currency:"USDT"},
             {account_id:"44",entry_type:"credit",amount:"1",currency:"USDT"}]
   })
  }),/deposit transaction type/);
  const rejected=await pool.query(`SELECT
   (SELECT count(*)::int FROM verified_deposit_evidence WHERE event_key=$1) AS evidence_count,
   (SELECT count(*)::int FROM ledger_transactions WHERE idempotency_key=$2) AS journal_count`,
   [eventKey,"verified-deposit:"+eventKey]);
  assert.deepEqual(rejected.rows[0],{evidence_count:0,journal_count:0});
  const result=await rehearseVerifiedDepositPosting({pool,evidence,tokenDecimals:18,
   destinationOwner:{accountId:"44",userId:"12"},
   journalForUnits:({eventKey})=>({
    transactionType:"deposit",idempotencyKey:"verified-deposit:"+eventKey,
    entries:[{account_id:"45",entry_type:"debit",amount:"1",currency:"USDT"},
             {account_id:"44",entry_type:"credit",amount:"1",currency:"USDT"}]
   })});
  assert.equal(result.posted,true);
  const rows=await pool.query(`SELECT (SELECT count(*)::int FROM verified_deposit_evidence WHERE event_key=$1) AS evidence_count,
   (SELECT count(*)::int FROM ledger_transactions WHERE idempotency_key=$2 AND status='posted') AS journal_count,
   (SELECT count(*)::int FROM ledger_entries WHERE transaction_id=$3) AS entry_count`,
   [eventKey,"verified-deposit:"+eventKey,result.transactionId]);
  assert.deepEqual(rows.rows[0],{evidence_count:1,journal_count:1,entry_count:2});
  // A replay must not create a second journal or alter the first credit.
  await assert.rejects(rehearseVerifiedDepositPosting({pool,evidence,tokenDecimals:18,
   destinationOwner:{accountId:"44",userId:"12"},
   journalForUnits:()=>{throw new Error("replay must not build another journal");}
  }),/duplicate key/);
  const replay=await pool.query(`SELECT
   (SELECT count(*)::int FROM verified_deposit_evidence WHERE event_key=$1) AS evidence_count,
   (SELECT count(*)::int FROM ledger_transactions WHERE idempotency_key=$2) AS journal_count,
   (SELECT count(*)::int FROM ledger_entries WHERE transaction_id=$3) AS entry_count`,
   [eventKey,"verified-deposit:"+eventKey,result.transactionId]);
  assert.deepEqual(replay.rows[0],{evidence_count:1,journal_count:1,entry_count:2});
 }finally{
  if(pool)await pool.end();
  await admin.query('DROP SCHEMA IF EXISTS "'+schema+'" CASCADE');
  await admin.end();
 }
});

test("missing destination owner cannot post and rolls back evidence", {skip:!safe()},async()=>{
 const pool=new pg.Pool({connectionString:url,max:1});
 const evidence={chainId:56,transactionHash:"0x"+"6".repeat(64),logIndex:6,
  blockHash:"0x"+"b".repeat(64),blockNumber:"100",tokenContract:"0x"+"c".repeat(40),
  depositAddress:"0x"+"d".repeat(40),amountBaseUnits:"1000000000000000000"};
 const key="bsc:56:"+evidence.transactionHash+":6";
 let journalCalled=false;
 try{
  await pool.query(`CREATE TEMP TABLE verified_deposit_evidence (
   event_key text PRIMARY KEY,block_hash text NOT NULL,block_number numeric(78,0) NOT NULL,
   token_contract text NOT NULL,deposit_address text NOT NULL,amount_base_units numeric(78,0) NOT NULL)`);
  await assert.rejects(rehearseVerifiedDepositPosting({pool,evidence,tokenDecimals:18,
   journalForUnits:({eventKey})=>{journalCalled=true;return {idempotencyKey:"verified-deposit:"+eventKey,
    entries:[{account_id:"45",entry_type:"debit",amount:"1",currency:"USDT"},
             {account_id:"44",entry_type:"credit",amount:"1",currency:"USDT"}]};}
  }),/destination owner required/);
  assert.equal(journalCalled,false);
  const rows=await pool.query("SELECT count(*)::int AS count FROM pg_temp.verified_deposit_evidence WHERE event_key=$1",[key]);
  assert.equal(rows.rows[0].count,0);
 }finally{await pool.end();}
});

test("customer AVAILABLE source cannot fund a rehearsed deposit",{skip:!safe()},async()=>{
 const pool=new pg.Pool({connectionString:url,max:1});
 const evidence={chainId:56,transactionHash:"0x"+"7".repeat(64),logIndex:7,
  blockHash:"0x"+"b".repeat(64),blockNumber:"100",tokenContract:"0x"+"c".repeat(40),
  depositAddress:"0x"+"d".repeat(40),amountBaseUnits:"1000000000000000000"};
 const key="bsc:56:"+evidence.transactionHash+":7";
 try{
  await pool.query(`CREATE TEMP TABLE verified_deposit_evidence (
   event_key text PRIMARY KEY,block_hash text NOT NULL,block_number numeric(78,0) NOT NULL,
   token_contract text NOT NULL,deposit_address text NOT NULL,amount_base_units numeric(78,0) NOT NULL)`);
  await pool.query(`CREATE TEMP TABLE ledger_accounts (
   id bigint PRIMARY KEY,user_id bigint,account_type text,currency text)`);
  await pool.query("INSERT INTO pg_temp.ledger_accounts VALUES (44,12,'AVAILABLE','USDT'),(45,13,'AVAILABLE','USDT')");
  await assert.rejects(rehearseVerifiedDepositPosting({pool,evidence,tokenDecimals:18,
   destinationOwner:{accountId:"44",userId:"12"},
   journalForUnits:({eventKey})=>({transactionType:"deposit",
    idempotencyKey:"verified-deposit:"+eventKey,
    entries:[{account_id:"45",entry_type:"debit",amount:"1",currency:"USDT"},
             {account_id:"44",entry_type:"credit",amount:"1",currency:"USDT"}]})
  }),/platform clearing account/);
  const rows=await pool.query("SELECT count(*)::int AS count FROM pg_temp.verified_deposit_evidence WHERE event_key=$1",[key]);
  assert.equal(rows.rows[0].count,0);
 }finally{await pool.end();}
});

test("user-owned CLEARING source cannot fund a rehearsed deposit",{skip:!safe()},async()=>{
 const pool=new pg.Pool({connectionString:url,max:1});
 const evidence={chainId:56,transactionHash:"0x"+"7".repeat(64),logIndex:7,
  blockHash:"0x"+"b".repeat(64),blockNumber:"100",tokenContract:"0x"+"c".repeat(40),
  depositAddress:"0x"+"d".repeat(40),amountBaseUnits:"1000000000000000000"};
 const key="bsc:56:"+evidence.transactionHash+":7";
 try{
  await pool.query(`CREATE TEMP TABLE verified_deposit_evidence (
   event_key text PRIMARY KEY,block_hash text NOT NULL,block_number numeric(78,0) NOT NULL,
   token_contract text NOT NULL,deposit_address text NOT NULL,amount_base_units numeric(78,0) NOT NULL)`);
  await pool.query(`CREATE TEMP TABLE ledger_accounts (
   id bigint PRIMARY KEY,user_id bigint,account_type text,currency text)`);
  await pool.query("INSERT INTO pg_temp.ledger_accounts VALUES (44,12,'AVAILABLE','USDT'),(45,13,'CLEARING','USDT')");
  await assert.rejects(rehearseVerifiedDepositPosting({pool,evidence,tokenDecimals:18,
   destinationOwner:{accountId:"44",userId:"12"},
   journalForUnits:({eventKey})=>({transactionType:"deposit",
    idempotencyKey:"verified-deposit:"+eventKey,
    entries:[{account_id:"45",entry_type:"debit",amount:"1",currency:"USDT"},
             {account_id:"44",entry_type:"credit",amount:"1",currency:"USDT"}]})
  }),/platform clearing account/);
  const rows=await pool.query("SELECT count(*)::int AS count FROM pg_temp.verified_deposit_evidence WHERE event_key=$1",[key]);
  assert.equal(rows.rows[0].count,0);
 }finally{await pool.end();}
});
