import test from "node:test";
import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";
import {readFile} from "node:fs/promises";
import pg from "pg";
import {isDisposablePostgresTarget} from "../test-support/disposable-postgres-target.js";
import {reconcileSimulatedLiabilities} from "../test-support/reconcile-simulated-liabilities.js";
import {createSimulationWithdrawalTables} from "../test-support/withdrawal-schema.js";
import {postLedgerTransaction} from "./ledger-posting.js";

const enabled=isDisposablePostgresTarget(process.env.DATABASE_URL,"profino_test");
test("independent simulated obligations expose per-customer shortages even with equal aggregate totals",{skip:!enabled},async()=>{
  const schema="liability_it_"+randomUUID().replaceAll("-","");
  const admin=new pg.Pool({connectionString:process.env.DATABASE_URL});
  let pool;
  try{
    await admin.query(`CREATE SCHEMA "${schema}"`);
    pool=new pg.Pool({connectionString:process.env.DATABASE_URL,options:`-c search_path=${schema}`});
    await pool.query(await readFile(new URL("../test/fixtures/ledger-contract.sql",import.meta.url),"utf8"));
    await createSimulationWithdrawalTables(pool);
    await pool.query(`CREATE TABLE simulation_investments(user_id bigint REFERENCES users(id),principal integer,status text);
      INSERT INTO users VALUES (1),(2),(3);
      INSERT INTO ledger_accounts(id,user_id,account_code,account_type) VALUES
      (1,NULL,'clearing','CLEARING'),(2,1,'i1','INVESTED'),(3,2,'i2','INVESTED'),
      (4,1,'a1','AVAILABLE'),(5,1,'h1','WITHDRAWAL_HOLD');
      INSERT INTO simulation_investments VALUES (1,10,'active'),(2,20,'active'),(1,99,'settled');
      INSERT INTO simulation_withdrawals(user_id,request_key,amount,available_id,held_id,status) VALUES
        (1,'hold',5,4,5,'reserved'),(1,'cancelled',99,4,5,'cancelled');`);
    const move=async(from,to,amount,key)=>postLedgerTransaction({pool,transactionType:"synthetic-liability",idempotencyKey:key,entries:[
      {account_id:String(from),entry_type:"debit",amount,currency:"USDT"},
      {account_id:String(to),entry_type:"credit",amount,currency:"USDT"}]});
    await move(1,2,"10","i1"); await move(1,3,"20","i2"); await move(1,5,"5","hold");
    assert.equal((await reconcileSimulatedLiabilities(pool)).clean,true);
    await move(2,3,"1","misattribution");
    await move(1,5,"1","overhold");
    await pool.query("INSERT INTO simulation_investments VALUES (3,10,'active')");
    const report=await reconcileSimulatedLiabilities(pool);
    assert.deepEqual(report.counts,{investment_mismatches:"3",withdrawal_mismatches:"1",missing_accounts:"1",duplicate_accounts:"0"});
    assert.equal(report.clean,false);assert.equal(report.custodyVerified,false);
    assert.equal(report.productionReady,false);
  }finally{
    if(pool)await pool.end();
    try{await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);}finally{await admin.end();}
  }
});
