import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import pg from "pg";
import { isDisposablePostgresTarget } from "../test-support/disposable-postgres-target.js";
import { openSimulatedInvestment,settleSimulatedInvestment } from "../test-support/simulated-investment.js";
import { postLedgerTransaction } from "./ledger-posting.js";
const enabled=isDisposablePostgresTarget(process.env.DATABASE_URL,"profino_test");
async function fixture(fn){
  const schema="investment_terms_"+randomUUID().replaceAll("-","");
  const admin=new pg.Pool({connectionString:process.env.DATABASE_URL});
  let pool;
  try{
    await admin.query(`CREATE SCHEMA "${schema}"`);
    pool=new pg.Pool({connectionString:process.env.DATABASE_URL,options:`-c search_path=${schema}`});
    await pool.query(await readFile(new URL("../test/fixtures/ledger-contract.sql",import.meta.url),"utf8"));
    await pool.query(`ALTER TABLE users ADD COLUMN status text;
      INSERT INTO users(id,status) VALUES (1,'active'),(2,'active');
      CREATE TABLE simulation_investments (
        id bigserial PRIMARY KEY,user_id bigint NOT NULL REFERENCES users(id),request_id text NOT NULL,
        plan text NOT NULL,principal integer NOT NULL,profit_percent integer NOT NULL,fee_percent integer NOT NULL,
        opened_at timestamptz NOT NULL DEFAULT now(),matures_at timestamptz NOT NULL,
        settlement_id bigint UNIQUE REFERENCES ledger_transactions(id),status text NOT NULL DEFAULT 'active',
        UNIQUE(user_id,request_id)
      );
      INSERT INTO ledger_accounts(user_id,account_code,account_type) VALUES
        (1,'available','AVAILABLE'),(1,'invested','INVESTED'),
        (NULL,'reserve','AVAILABLE'),(NULL,'fee','CLEARING'),(NULL,'source','CLEARING')`);
    const {rows}=await pool.query("SELECT id,account_code FROM ledger_accounts");
    const accounts=Object.fromEntries(rows.map(x=>[x.account_code,x.id]));
    await postLedgerTransaction({pool,transactionType:"test-funding",idempotencyKey:"test-funding",entries:[
      {account_id:accounts.source,entry_type:"debit",amount:"100",currency:"USDT"},
      {account_id:accounts.available,entry_type:"credit",amount:"75",currency:"USDT"},
      {account_id:accounts.reserve,entry_type:"credit",amount:"25",currency:"USDT"}
    ]});
    const review=await readFile(new URL("../test/fixtures/investment-terms.review.sql",import.meta.url),"utf8");
    await fn(pool,accounts,review);
  }finally{
    if(pool) await pool.end();
    try{await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);}finally{await admin.end();}
  }
}
test("reviewed investment contract prevents maturity and terms edits and allows original replay",{skip:!enabled},async()=>{
  await fixture(async(pool,a,review)=>{
    await pool.query(review);
    const id=await openSimulatedInvestment(pool,1,"immutable","SMART 25");
    const read=async()=>(await pool.query("SELECT *,matures_at=opened_at+interval '720 hours' AS valid_term FROM simulation_investments WHERE id=$1",[id])).rows[0];
    const before=await read();
    assert.equal(before.valid_term,true);
    for(const change of ["matures_at=now()","opened_at=opened_at-interval '1 day'",
      "profit_percent=99","fee_percent=1","principal=50","plan='PRO'","user_id=2","request_id='other'",
      "opened_at=opened_at-interval '1 day',matures_at=matures_at-interval '1 day'"]){
      await assert.rejects(pool.query("UPDATE simulation_investments SET "+change+" WHERE id=$1",[id]),e=>e.code==="23514");
    }
    await assert.rejects(pool.query("DELETE FROM simulation_investments WHERE id=$1",[id]),e=>e.code==="23514");
    await assert.rejects(settleSimulatedInvestment(pool,1,id,a.reserve,a.fee),/not due/);
    assert.deepEqual(await read(),before);
    assert.equal(await openSimulatedInvestment(pool,1,"immutable","SMART 25"),id);
  });
});
test("reviewed investment guard permits a due synthetic settlement and protects terminal history",{skip:!enabled},async()=>{
  await fixture(async(pool,a,review)=>{
    // Historical timestamps are seeded only in the disposable fixture before installing the guard.
    const {rows:[i]}=await pool.query(`INSERT INTO simulation_investments(user_id,request_id,plan,principal,profit_percent,fee_percent,opened_at,matures_at)
       VALUES(1,'historical','STARTER',25,4,2,now()-interval '264 hours',now()-interval '24 hours') RETURNING id`);
    await postLedgerTransaction({pool,transactionType:"simulated-investment-open",referenceId:i.id,idempotencyKey:"simulated-investment-open:"+i.id,
      entries:[{account_id:a.available,entry_type:"debit",amount:"25",currency:"USDT"},{account_id:a.invested,entry_type:"credit",amount:"25",currency:"USDT"}]});
    await pool.query(review);
    const {rows:[wrong]}=await pool.query("SELECT id FROM ledger_transactions WHERE idempotency_key='test-funding'");
    await assert.rejects(pool.query("UPDATE simulation_investments SET status='settled',settlement_id=$2 WHERE id=$1",[i.id,wrong.id]),e=>e.code==="23514");
    const journal=await settleSimulatedInvestment(pool,1,i.id,a.reserve,a.fee);
    assert.equal(await settleSimulatedInvestment(pool,1,i.id,a.reserve,a.fee),journal);
    await assert.rejects(pool.query("UPDATE simulation_investments SET status='active',settlement_id=NULL WHERE id=$1",[i.id]),e=>e.code==="23514");
    assert.deepEqual((await pool.query("SELECT status,settlement_id FROM simulation_investments WHERE id=$1",[i.id])).rows[0],{status:"settled",settlement_id:journal});
  });
});
