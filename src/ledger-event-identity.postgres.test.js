import test from "node:test";
import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";
import {readFile} from "node:fs/promises";
import pg from "pg";
import {isDisposablePostgresTarget} from "../test-support/disposable-postgres-target.js";
import {postLedgerTransaction} from "./ledger-posting.js";

const enabled=isDisposablePostgresTarget(process.env.DATABASE_URL,"profino_test");
const event=n=>"bsc:56:0x"+n.toString(16).padStart(64,"0")+":0";
const key=ref=>"confirmed-deposit:"+ref;
async function fixture(fn){
  const schema="ledger_guard_"+randomUUID().replaceAll("-","");
  const admin=new pg.Pool({connectionString:process.env.DATABASE_URL});
  let pool;
  try{
    await admin.query(`CREATE SCHEMA "${schema}"`);
    pool=new pg.Pool({connectionString:process.env.DATABASE_URL,options:`-c search_path=${schema}`});
    await pool.query(await readFile(new URL("../test/fixtures/ledger-contract.sql",import.meta.url),"utf8"));
    const review=await readFile(new URL("../test/fixtures/ledger-event-identity.review.sql",import.meta.url),"utf8");
    await fn(pool,review);
  }finally{
    if(pool) await pool.end();
    try{await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);}finally{await admin.end();}
  }
}
const insert=(pool,type,reference,idempotency)=>pool.query(
  "INSERT INTO ledger_transactions(transaction_type,reference_id,idempotency_key) VALUES ($1,$2,$3) RETURNING id",
  [type,reference,idempotency]);
test("review constraint blocks direct SQL event identity bypass and concurrent duplicate insert",{skip:!enabled},async()=>{
  await fixture(async(pool,review)=>{
    await pool.query(review);
    const ref=event(1);
    for(const [type,r,k] of [
      ["confirmed-deposit",ref,"alternate-key"],
      ["confirmed-deposit",null,key(ref)],
      ["confirmed-deposit",ref,null],
      ["confirmed-deposit",ref.toUpperCase(),key(ref.toUpperCase())],
      ["confirmed-deposit",ref.replace(/:0$/,":00"),key(ref.replace(/:0$/,":00"))],
      ["other-credit",ref,"other-key"],
      ["other-credit","other-reference",key(ref)],
      ["other-credit",ref.toUpperCase(),"other-uppercase-key"]
    ]) await assert.rejects(insert(pool,type,r,k),e=>e.code==="23514");
    const outcomes=await Promise.allSettled(Array.from({length:8},()=>insert(pool,"confirmed-deposit",ref,key(ref))));
    assert.equal(outcomes.filter(o=>o.status==="fulfilled").length,1);
    assert.ok(outcomes.filter(o=>o.status==="rejected").every(o=>o.reason.code==="23505"));
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM ledger_transactions WHERE reference_id=$1",[ref])).rows[0].n,1);
    // Separate logs in one transaction are different canonical events.
    const second=ref.replace(/:0$/,":1");
    await insert(pool,"confirmed-deposit",second,key(second));
    await insert(pool,"internal-transfer","internal-reference","internal-key");
    await assert.rejects(pool.query("UPDATE ledger_transactions SET idempotency_key='alternate' WHERE reference_id=$1",[ref]),e=>e.code==="23514");
  });
});
test("review constraint accepts existing valid journal and normal service replay",{skip:!enabled},async()=>{
  await fixture(async(pool,review)=>{
    await pool.query("INSERT INTO ledger_accounts(id,account_code,account_type) VALUES (1,'clearing','CLEARING'),(2,'available','AVAILABLE')");
    const ref=event(2);
    const journal={pool,transactionType:"confirmed-deposit",referenceId:ref,idempotencyKey:key(ref),entries:[
      {account_id:"1",entry_type:"debit",amount:"25",currency:"USDT"},
      {account_id:"2",entry_type:"credit",amount:"25",currency:"USDT"}]};
    const first=await postLedgerTransaction(journal);
    await pool.query(review);
    const again=await postLedgerTransaction(journal);
    assert.equal(again.transactionId,first.transactionId);
    assert.equal(again.idempotent,true);
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM ledger_transactions")).rows[0].n,1);
  });
});
test("legacy conflicting records stop reviewed DDL without repair or partial installation",{skip:!enabled},async()=>{
  await fixture(async(pool,review)=>{
    const ref=event(3);
    await insert(pool,"confirmed-deposit",ref,key(ref));
    await insert(pool,"confirmed-deposit",ref,"legacy-alternate");
    const before=(await pool.query("SELECT * FROM ledger_transactions ORDER BY id")).rows;
    const client=await pool.connect();
    try{
      await client.query("BEGIN");
      await assert.rejects(client.query(review),e=>e.code==="23514");
      await client.query("ROLLBACK");
    }finally{client.release();}
    assert.deepEqual((await pool.query("SELECT * FROM ledger_transactions ORDER BY id")).rows,before);
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM pg_constraint WHERE conrelid='ledger_transactions'::regclass AND conname='ledger_confirmed_deposit_identity_review'")).rows[0].n,0);
    assert.equal((await pool.query("SELECT to_regclass('ledger_confirmed_deposit_event_review') AS idx")).rows[0].idx,null);
  });
});
