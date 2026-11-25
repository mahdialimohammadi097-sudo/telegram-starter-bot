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
      ALTER TABLE ledger_transactions DISABLE TRIGGER ledger_transactions_balance_check;
      INSERT INTO ledger_transactions(id,transaction_type,idempotency_key,status)
        VALUES (6,'empty','empty-key','posted');
      ALTER TABLE ledger_transactions ENABLE TRIGGER ledger_transactions_balance_check;
    `);
    const bad=await auditLedgerIntegrity(admin,{schema});
    assert.equal(bad.clean,false);
    assert.deepEqual(bad.counts,{journals:"6",posted_journals:"5",entries:"8",
      unresolved_journals:"1",missing_idempotency_keys:"1",duplicate_idempotency_keys:"0",
      invalid_entries:"4",unbalanced_posted_journals:"1",negative_customer_accounts:"1"});
    assert.equal(bad.custodyVerified,false);
    assert.equal(bad.productionReady,false);
  } finally {
    if(fixture) await fixture.end();
    try { await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); } finally { await admin.end(); }
  }
});
