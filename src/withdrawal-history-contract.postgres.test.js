import test from "node:test";
import assert from "node:assert/strict";
import {randomUUID,createHash} from "node:crypto";
import {readFile} from "node:fs/promises";
import pg from "pg";
import {isDisposablePostgresTarget} from "../test-support/disposable-postgres-target.js";
import {createSimulationWithdrawalTables} from "../test-support/withdrawal-schema.js";
import {reserveWithdrawal,cancelWithdrawal,submitSimulatedWithdrawal,confirmTestnetWithdrawal} from "../test-support/simulated-withdrawal.js";
import {postLedgerTransaction} from "./ledger-posting.js";
const enabled=isDisposablePostgresTarget(process.env.DATABASE_URL,"profino_test");
async function fixture(fn){
 const schema="withdrawal_history_"+randomUUID().replaceAll("-","");
 const admin=new pg.Pool({connectionString:process.env.DATABASE_URL});
 let pool;
 try{
  await admin.query(`CREATE SCHEMA "${schema}"`);
  pool=new pg.Pool({connectionString:process.env.DATABASE_URL,options:`-c search_path=${schema}`});
  await pool.query(await readFile(new URL("../test/fixtures/ledger-contract.sql",import.meta.url),"utf8"));
  await pool.query(`ALTER TABLE users ADD COLUMN status text;
    INSERT INTO users(id,status) VALUES (1,'active'),(2,'active');
    INSERT INTO ledger_accounts(user_id,account_code,account_type) VALUES
     (1,'available','AVAILABLE'),(2,'other','AVAILABLE'),(NULL,'clearing','CLEARING')`);
  await createSimulationWithdrawalTables(pool);
  const {rows}=await pool.query("SELECT id,account_code FROM ledger_accounts");
  const a=Object.fromEntries(rows.map(x=>[x.account_code,x.id]));
  await postLedgerTransaction({pool,transactionType:"test-funding",idempotencyKey:"test-funding",entries:[
    {account_id:a.clearing,entry_type:"debit",amount:"25",currency:"USDT"},
    {account_id:a.available,entry_type:"credit",amount:"25",currency:"USDT"}]});
  await pool.query(await readFile(new URL("../test/fixtures/withdrawal-history.review.sql",import.meta.url),"utf8"));
  await fn(pool,a);
 }finally{
  if(pool)await pool.end();
  try{await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);}finally{await admin.end();}
 }
}
const invalid=e=>e.code==="23514";
test("withdrawal contract rejects identity edits and false cancellation while preserving valid release",{skip:!enabled},async()=>{
 await fixture(async(pool,a)=>{
  const w=await reserveWithdrawal(pool,1,"immutable","10");
  const read=async()=>(await pool.query("SELECT * FROM simulation_withdrawals WHERE id=$1",[w.id])).rows[0];
  const original=await read();
  for(const change of ["amount=11","user_id=2","request_key='other'","destination='0x'","available_id="+a.other]){
   await assert.rejects(pool.query("UPDATE simulation_withdrawals SET "+change+" WHERE id=$1",[w.id]),invalid);
  }
  const {rows:[wrong]}=await pool.query("SELECT id FROM ledger_transactions WHERE idempotency_key='test-funding'");
  await assert.rejects(pool.query("UPDATE simulation_withdrawals SET status='cancelled',release_id=$2 WHERE id=$1",[w.id,wrong.id]),invalid);
  await assert.rejects(pool.query("DELETE FROM simulation_withdrawals WHERE id=$1",[w.id]),invalid);
  assert.deepEqual(await read(),original);
  const release=await cancelWithdrawal(pool,1,w.id);
  assert.equal(await cancelWithdrawal(pool,1,w.id),release);
  await assert.rejects(pool.query("UPDATE simulation_withdrawals SET status='reserved',release_id=NULL WHERE id=$1",[w.id]),invalid);
  assert.equal((await read()).release_id,release);
 });
});
test("withdrawal contract freezes submission and paid state using only synthetic receipt",{skip:!enabled},async()=>{
 await fixture(async(pool,a)=>{
  const sample=JSON.parse(await readFile(new URL("../test/fixtures/bsc-testnet-transfer.json",import.meta.url),"utf8"));
  const w=await reserveWithdrawal(pool,1,"synthetic","1",sample.expected.recipient);
  const payload=Buffer.from("offline-withdrawal-history-review");
  const hash="0x"+createHash("sha256").update(payload).digest("hex");
  sample.expected.txHash=hash;
  sample.observation.receipt.transactionHash=hash;
  for(const log of sample.observation.receipt.logs)log.transactionHash=hash;
  let sends=0;
  await submitSimulatedWithdrawal(pool,w.id,hash,async()=>{sends++;},payload);
  await assert.rejects(pool.query("UPDATE simulation_withdrawals SET simulation_payload=$2 WHERE id=$1",[w.id,Buffer.from("changed")]),invalid);
  await assert.rejects(pool.query("UPDATE simulation_withdrawals SET status='reserved',submitted_hash=NULL,simulation_payload=NULL WHERE id=$1",[w.id]),invalid);
  await assert.rejects(cancelWithdrawal(pool,1,w.id),/cannot be cancelled/);
  const treasury={sender:"0x03e37a3686a553735dd9737a060e4a2c6c018ace",accountId:a.clearing};
  const confirm=()=>confirmTestnetWithdrawal(pool,w.id,sample.observation,sample.expected,treasury);
  const journal=await confirm();
  assert.equal(await confirm(),journal);
  await assert.rejects(pool.query("UPDATE simulation_withdrawals SET status='pending_receipt',payout_event=NULL,payout_id=NULL,clearing_id=NULL WHERE id=$1",[w.id]),invalid);
  assert.equal(sends,1);
 });
});
