import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import pg from "pg";
import { isDisposablePostgresTarget } from "../test-support/disposable-postgres-target.js";
import { createSimulationWithdrawalTables } from "../test-support/withdrawal-schema.js";
import { registerOwnerRehearsal } from "./owner-rehearsal.js";
import { postLedgerTransaction } from "./ledger-posting.js";
import { getWalletBalances } from "./wallet-balances.js";
import { formatUsdt } from "./ledger-safety.js";
import { auditLedgerIntegrity } from "./ledger-integrity-audit.js";

const enabled=isDisposablePostgresTarget(process.env.DATABASE_URL,"profino_test");
test("owner rehearsal uses a separate marked PostgreSQL database and rejects replay or missing marker",{skip:!enabled,timeout:60000},async()=>{
  const database="owner_rehearsal_test_"+randomUUID().replaceAll("-","");
  const admin=new pg.Pool({connectionString:process.env.DATABASE_URL});
  let fixture,created=false;
  try{
    const {rows:[identity]}=await admin.query("SELECT current_database() AS name");
    assert.equal(identity.name,"profino_test");
    // Only a freshly created random database on the opted-in disposable CI host.
    await admin.query('CREATE DATABASE "'+database+'"');
    created=true;
    await admin.query('ALTER DATABASE "'+database+'" SET profino.environment TO \'isolated-staging\'');
    const url=new URL(process.env.DATABASE_URL);
    url.pathname="/"+database;
    fixture=new pg.Pool({connectionString:url.href});
    await fixture.query(await readFile(new URL("../test/fixtures/ledger-contract.sql",import.meta.url),"utf8"));
    await createSimulationWithdrawalTables(fixture);
    await fixture.query(`ALTER TABLE users ADD COLUMN telegram_id bigint UNIQUE, ADD COLUMN status text;
      INSERT INTO users VALUES(1,7001,'active');
      INSERT INTO ledger_accounts(user_id,account_code,account_type)
      VALUES(1,'available','AVAILABLE'),(1,'invested','INVESTED'),(1,'profit','PROFIT'),(NULL,'clearing','CLEARING');`);
    const {rows}=await fixture.query("SELECT id,account_code FROM ledger_accounts");
    const accounts=Object.fromEntries(rows.map(row=>[row.account_code,row.id]));
    await postLedgerTransaction({pool:fixture,transactionType:"synthetic-fixture",idempotencyKey:"owner-fixture",
      entries:[{account_id:accounts.clearing,entry_type:"debit",amount:"5",currency:"USDT"},
        {account_id:accounts.available,entry_type:"credit",amount:"5",currency:"USDT"}]});
    const messages=[];
    let handler;
    registerOwnerRehearsal({command(command,fn){assert.equal(command,"admintest");handler=fn;}},{
      productionPool:admin,ownerId:7001,getLanguage:async()=>"en",
      env:{PROFINO_TEST_DATABASE_URL:url.href,PROFINO_TEST_DATABASE_NAME:database}
    });
    const ctx={from:{id:7001},chat:{type:"private",id:7001},message:{message_id:32},
      reply:async text=>messages.push(text)};
    const counts=async()=> (await fixture.query(`SELECT
      (SELECT count(*) FROM simulation_withdrawals)::text AS requests,
      (SELECT count(*) FROM ledger_transactions)::text AS journals,
      (SELECT count(*) FROM ledger_entries)::text AS entries`)).rows[0];
    await handler(ctx);
    assert.match(messages[0],/^Admin test passed/);
    const balance=await getWalletBalances(fixture,1);
    assert.equal(formatUsdt(balance.AVAILABLE),"5.00000000");
    assert.equal(formatUsdt(balance.WITHDRAWAL_HOLD),"0.00000000");
    const {rows:requests}=await fixture.query("SELECT request_key,status,release_id FROM simulation_withdrawals");
    assert.equal(requests.length,1);
    assert.equal(requests[0].request_key,"owner-rehearsal:32");
    assert.equal(requests[0].status,"cancelled");
    assert.ok(requests[0].release_id);
    const expected={requests:"1",journals:"3",entries:"6"};
    assert.deepEqual(await counts(),expected);
    assert.equal((await auditLedgerIntegrity(fixture)).clean,true);
    await handler(ctx);
    assert.match(messages[1],/^Admin test could not be completed/);
    assert.deepEqual(await counts(),expected);
    // New connections must fail the database-wide identity check, not write.
    await admin.query('ALTER DATABASE "'+database+'" RESET profino.environment');
    await handler({...ctx,message:{message_id:33}});
    assert.match(messages[2],/^Admin test could not be completed/);
    assert.deepEqual(await counts(),expected);
  }finally{
    try{if(fixture)await fixture.end();}
    finally{
      try{if(created)await admin.query('DROP DATABASE "'+database+'" WITH (FORCE)');}
      finally{await admin.end();}
    }
  }
});
