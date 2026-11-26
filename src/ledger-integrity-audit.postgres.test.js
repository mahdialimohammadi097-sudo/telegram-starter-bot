import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import pg from "pg";
import { isDisposablePostgresTarget } from "../test-support/disposable-postgres-target.js";
import { auditLedgerIntegrity } from "./ledger-integrity-audit.js";

const enabled = isDisposablePostgresTarget(process.env.DATABASE_URL, "profino_test");
test("PostgreSQL integrity audit detects internal anomalies even when posted journals appear balanced", {skip:!enabled}, async()=>{
  const schema="ledger_audit_"+randomUUID().replaceAll("-","");
  const admin=new pg.Pool({connectionString:process.env.DATABASE_URL});
  let fixture;
  try {
    await admin.query(`CREATE SCHEMA "${schema}"`);
    fixture=new pg.Pool({connectionString:process.env.DATABASE_URL,options:`-c search_path=${schema}`});
    await fixture.query(await readFile(new URL("../test/fixtures/ledger-contract.sql",import.meta.url),"utf8"));
    await fixture.query(`INSERT INTO users VALUES (1);
      INSERT INTO ledger_accounts(id,user_id,account_code,account_type,currency) VALUES
      (1,1,'customer','AVAILABLE','USDT'),(2,NULL,'clearing','CLEARING','USDT');
      INSERT INTO ledger_transactions(id,transaction_type,idempotency_key) VALUES (1,'opening','opening-key');
      INSERT INTO ledger_entries(transaction_id,account_id,entry_type,amount) VALUES
      (1,1,'credit',10),(1,2,'debit',10);
      UPDATE ledger_transactions SET status='posted' WHERE id=1;`);
    const clean=await auditLedgerIntegrity(admin,{schema});
    assert.equal(clean.clean,true);
    assert.equal(clean.counts.journals,"1");
    // These are intentionally corrupted rows in a disposable schema, never production.
    await fixture.query(`
      INSERT INTO ledger_transactions(id,transaction_type,idempotency_key) VALUES
        (2,'overspend','overspend-key'),(3,'wrong-currency','wrong-currency-key'),
        (4,'subunit','subunit-key'),(5,'unresolved',NULL);
      INSERT INTO ledger_entries(transaction_id,account_id,entry_type,amount,currency) VALUES
        (2,1,'debit',11,'USDT'),(2,2,'credit',11,'USDT'),
        (3,1,'credit',1,'USDC'),(3,2,'debit',1,'USDC'),
        (4,1,'debit',0.000000001,'USDT'),(4,2,'credit',0.000000001,'USDT');
      UPDATE ledger_transactions SET status='posted' WHERE id IN (2,3,4);
    `);
    await fixture.query(`
      ALTER TABLE ledger_transactions DISABLE TRIGGER ledger_transactions_balance_check;
      INSERT INTO ledger_transactions(id,transaction_type,idempotency_key,status)
        VALUES (6,'empty','empty-key','posted');
      ALTER TABLE ledger_transactions ENABLE TRIGGER ledger_transactions_balance_check;
    `);
    const bad=await auditLedgerIntegrity(admin,{schema});
    assert.equal(bad.clean,false);
    assert.deepEqual(bad.counts,{journals:"6",posted_journals:"5",entries:"8",
      unresolved_journals:"1",missing_idempotency_keys:"1",duplicate_idempotency_keys:"0",
      invalid_entries:"4",invalid_account_currencies:"0",noncanonical_idempotency_keys:"0",
      unbalanced_posted_journals:"1",negative_customer_accounts:"1"});
    assert.equal(bad.custodyVerified,false);
    assert.equal(bad.productionReady,false);
  } finally {
    if(fixture) await fixture.end();
    try { await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); } finally { await admin.end(); }
  }
});

test("ledger integrity detects blank and padded identities, unused non-USDT accounts and non-finite amounts",{skip:!enabled},async()=>{
  const schema="ledger_values_"+randomUUID().replaceAll("-","");
  const admin=new pg.Pool({connectionString:process.env.DATABASE_URL});
  let fixture;
  try{
    await admin.query('CREATE SCHEMA "'+schema+'"');
    fixture=new pg.Pool({connectionString:process.env.DATABASE_URL,options:"-c search_path="+schema});
    await fixture.query(await readFile(new URL("../test/fixtures/ledger-contract.sql",import.meta.url),"utf8"));
    await fixture.query("INSERT INTO ledger_accounts(id,account_code,account_type,currency) VALUES (1,'fixture-a','CLEARING','USDT'),(2,'fixture-b','CLEARING','USDT'),(3,'unused','CLEARING','USDC')");
    const unused=await auditLedgerIntegrity(admin,{schema});
    assert.equal(unused.counts.invalid_account_currencies,"1");
    assert.equal(unused.counts.invalid_entries,"0");
    assert.equal(unused.clean,false);
    await fixture.query("DELETE FROM ledger_accounts WHERE id=3");
    assert.equal((await auditLedgerIntegrity(admin,{schema})).clean,true);
    await fixture.query("INSERT INTO ledger_transactions(id,transaction_type,idempotency_key) VALUES (1,'fixture',$1),(2,'fixture',$2),(3,'fixture','nan-fixture')",["\t\n"," padded "]);
    await fixture.query("INSERT INTO ledger_entries(transaction_id,account_id,entry_type,amount) VALUES (3,1,'debit','NaN'),(3,2,'credit','NaN')");
    await fixture.query("UPDATE ledger_transactions SET status='posted' WHERE id=3");
    const bad=await auditLedgerIntegrity(admin,{schema});
    assert.equal(bad.counts.missing_idempotency_keys,"1");
    assert.equal(bad.counts.noncanonical_idempotency_keys,"1");
    assert.equal(bad.counts.invalid_entries,"2");
    assert.equal(bad.counts.invalid_account_currencies,"0");
    assert.equal(bad.clean,false);
    assert.equal(bad.productionReady,false);
    assert.equal(bad.custodyVerified,false);
  }finally{
    if(fixture)await fixture.end();
    try{await admin.query('DROP SCHEMA IF EXISTS "'+schema+'" CASCADE');}finally{await admin.end();}
  }
});

test("standalone ledger integrity refuses views, unlogged relations, inheritance and rewrite rules", {skip:!enabled},async()=>{
  const schema="ledger_shape_"+randomUUID().replaceAll("-","");
  const admin=new pg.Pool({connectionString:process.env.DATABASE_URL});
  let fixture;
  try{
    await admin.query('CREATE SCHEMA "'+schema+'"');
    fixture=new pg.Pool({connectionString:process.env.DATABASE_URL,options:"-c search_path="+schema});
    await fixture.query("CREATE TABLE ledger_accounts(id bigint); CREATE TABLE ledger_transactions(id bigint); CREATE VIEW ledger_entries AS SELECT 1 AS id WHERE false");
    const reject=()=>assert.rejects(auditLedgerIntegrity(admin,{schema}),/requires three permanent ordinary relations/);
    await reject();
    await fixture.query("DROP VIEW ledger_entries; CREATE UNLOGGED TABLE ledger_entries(id bigint)");
    await reject();
    await fixture.query("DROP TABLE ledger_entries; DROP TABLE ledger_accounts; DROP TABLE ledger_transactions");
    await fixture.query(await readFile(new URL("../test/fixtures/ledger-contract.sql",import.meta.url),"utf8"));
    assert.equal((await auditLedgerIntegrity(admin,{schema})).clean,true);
    await fixture.query("CREATE TABLE inherited_fixture() INHERITS (ledger_accounts)");
    await reject();
    await fixture.query("DROP TABLE inherited_fixture");
    await fixture.query("CREATE RULE fixture_rule AS ON DELETE TO ledger_accounts DO INSTEAD NOTHING");
    await reject();
    await fixture.query("DROP RULE fixture_rule ON ledger_accounts");
    assert.equal((await auditLedgerIntegrity(admin,{schema})).clean,true);
  }finally{
    if(fixture)await fixture.end();
    try{await admin.query('DROP SCHEMA IF EXISTS "'+schema+'" CASCADE');}finally{await admin.end();}
  }
});
