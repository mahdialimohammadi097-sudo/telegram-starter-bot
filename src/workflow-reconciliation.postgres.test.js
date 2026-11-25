import test from "node:test";
import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";
import {readFile} from "node:fs/promises";
import pg from "pg";
import {isDisposablePostgresTarget} from "../test-support/disposable-postgres-target.js";
import {createSimulationWithdrawalTables} from "../test-support/withdrawal-schema.js";
import {openSimulatedInvestment,settleSimulatedInvestment} from "../test-support/simulated-investment.js";
import {reserveWithdrawal,cancelWithdrawal} from "../test-support/simulated-withdrawal.js";
import {auditSimulatedWorkflow} from "../test-support/audit-simulated-workflow.js";
import {withLedgerTransaction,postJournalInTransaction,postLedgerTransaction} from "./ledger-posting.js";
import {getWalletBalances} from "./wallet-balances.js";
import {formatUsdt} from "./ledger-safety.js";
const enabled=isDisposablePostgresTarget(process.env.DATABASE_URL,"profino_test");

test("one read-only snapshot reconciles simulated deposit, investment and withdrawal lifecycle",{skip:!enabled},async()=>{
  const schema="workflow_review_"+randomUUID().replaceAll("-","");
  const admin=new pg.Pool({connectionString:process.env.DATABASE_URL});
  let pool;
  try{
    await admin.query(`CREATE SCHEMA "${schema}"`);
    pool=new pg.Pool({connectionString:process.env.DATABASE_URL,options:`-c search_path=${schema}`});
    await pool.query(await readFile(new URL("../test/fixtures/ledger-contract.sql",import.meta.url),"utf8"));
    await pool.query(`ALTER TABLE users ADD COLUMN status text;
      INSERT INTO users(id,status) VALUES(1,'active');
      CREATE TABLE deposit_requests(id bigserial PRIMARY KEY,user_id bigint REFERENCES users(id),
        amount numeric NOT NULL,transfer_event text NOT NULL,status text NOT NULL DEFAULT 'pending',reviewed_at timestamptz);
      CREATE TABLE simulation_investments(id bigserial PRIMARY KEY,user_id bigint REFERENCES users(id),request_id text NOT NULL,
        plan text NOT NULL,principal integer NOT NULL,profit_percent integer NOT NULL,fee_percent integer NOT NULL,
        opened_at timestamptz NOT NULL DEFAULT now(),matures_at timestamptz NOT NULL,
        settlement_id bigint UNIQUE REFERENCES ledger_transactions(id),status text NOT NULL DEFAULT 'active',UNIQUE(user_id,request_id));
      INSERT INTO ledger_accounts(user_id,account_code,account_type) VALUES
       (1,'available','AVAILABLE'),(1,'invested','INVESTED'),(1,'profit','PROFIT'),
       (NULL,'clearing','CLEARING'),(NULL,'reserve','AVAILABLE'),(NULL,'fee','CLEARING')`);
    await createSimulationWithdrawalTables(pool);
    const {rows}=await pool.query("SELECT id,account_code FROM ledger_accounts");
    const a=Object.fromEntries(rows.map(x=>[x.account_code,x.id]));
    const inspect=()=>auditSimulatedWorkflow(pool,{schema,clearingId:a.clearing,reserveId:a.reserve,feeId:a.fee});
    async function clean(){
      const result=await inspect();
      assert.equal(result.clean,true,JSON.stringify(result.counts));
      assert.equal(result.custodyVerified,false);
      assert.equal(result.productionReady,false);
    }
    const event="fixture:workflow:0";
    // Seed a synthetic approved deposit, never contact a chain or move real funds.
    const deposit=await withLedgerTransaction(pool,async client=>{
      const {rows:[d]}=await client.query("INSERT INTO deposit_requests(user_id,amount,transfer_event) VALUES(1,50,$1) RETURNING id",[event]);
      await postJournalInTransaction(client,{transactionType:"simulated-deposit",referenceId:d.id,idempotencyKey:"simulated-deposit:"+event,entries:[
        {account_id:a.clearing,entry_type:"debit",amount:"50",currency:"USDT"},
        {account_id:a.available,entry_type:"credit",amount:"50",currency:"USDT"}]});
      await client.query("UPDATE deposit_requests SET status='approved',reviewed_at=now() WHERE id=$1",[d.id]);
      return d.id;
    });
    await clean();
    const investment=await openSimulatedInvestment(pool,1,"workflow-open","SMART 25");
    const w=await reserveWithdrawal(pool,1,"workflow-withdraw","10");
    await clean();
    // Deliberately change only disposable fixture timestamps to exercise due settlement.
    await pool.query("UPDATE simulation_investments SET matures_at=now() WHERE id=$1",[investment]);
    await assert.rejects(settleSimulatedInvestment(pool,1,investment,a.reserve,a.fee),/Insufficient/);
    await clean();
    await postLedgerTransaction({pool,transactionType:"fixture-reserve",idempotencyKey:"fixture-reserve",entries:[
      {account_id:a.clearing,entry_type:"debit",amount:"3.5",currency:"USDT"},
      {account_id:a.reserve,entry_type:"credit",amount:"3.5",currency:"USDT"}]});
    const settled=await settleSimulatedInvestment(pool,1,investment,a.reserve,a.fee);
    assert.equal(await settleSimulatedInvestment(pool,1,investment,a.reserve,a.fee),settled);
    await clean();
    const release=await cancelWithdrawal(pool,1,w.id);
    assert.equal(await cancelWithdrawal(pool,1,w.id),release);
    await clean();
    const balances=await getWalletBalances(pool,1);
    assert.equal(formatUsdt(balances.AVAILABLE),"52.36000000");
    assert.equal(formatUsdt(balances.INVESTED),"0.00000000");
    assert.equal(formatUsdt(balances.WITHDRAWAL_HOLD),"0.00000000");
    // Each fault is committed only to the temporary fixture and restored after inspection.
    await pool.query("UPDATE deposit_requests SET amount=51 WHERE id=$1",[deposit]);
    assert.equal((await inspect()).counts.deposits,"1");
    await pool.query("UPDATE deposit_requests SET amount=50 WHERE id=$1",[deposit]);
    await pool.query("UPDATE simulation_investments SET principal=50 WHERE id=$1",[investment]);
    const corrupted=await inspect();
    assert.equal(corrupted.clean,false);
    assert.equal(corrupted.counts.openings,"1");
    assert.equal(corrupted.counts.settlements,"1");
    await pool.query("UPDATE simulation_investments SET principal=25 WHERE id=$1",[investment]);
    await pool.query("UPDATE simulation_withdrawals SET release_id=NULL WHERE id=$1",[w.id]);
    assert.equal((await inspect()).counts.withdrawals,"1");
    await pool.query("UPDATE simulation_withdrawals SET release_id=$2 WHERE id=$1",[w.id,release]);
    await clean();
  }finally{
    if(pool)await pool.end();
    try{await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);}finally{await admin.end();}
  }
});
