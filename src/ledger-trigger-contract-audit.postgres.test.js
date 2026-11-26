import test from "node:test";
import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";
import {readFile} from "node:fs/promises";
import pg from "pg";
import {isDisposablePostgresTarget} from "../test-support/disposable-postgres-target.js";
import {auditLedgerTriggerContract} from "./ledger-trigger-contract-audit.js";
import {collectLedgerReleaseEvidence} from "./ledger-release-audit.js";
const enabled=isDisposablePostgresTarget(process.env.DATABASE_URL,"profino_test");
test("ledger catalog audit detects disabled or missing financial guards without mutating them",{skip:!enabled},async()=>{
  const schema="ledger_trigger_"+randomUUID().replaceAll("-","");
  const admin=new pg.Pool({connectionString:process.env.DATABASE_URL});
  let pool;
  try{
    await admin.query(`CREATE SCHEMA "${schema}"`);
    pool=new pg.Pool({connectionString:process.env.DATABASE_URL,options:`-c search_path=${schema}`});
    await pool.query(await readFile(new URL("../test/fixtures/ledger-contract.sql",import.meta.url),"utf8"));
    const clean=await auditLedgerTriggerContract(admin,{schema});
    assert.equal(clean.compatible,true);
    assert.equal(clean.checks.length,4);
    assert.equal(clean.functionBodiesVerified,false);
    assert.equal(clean.productionReady,false);
    let connections=0;
    const countedPool={async connect(){connections++;return admin.connect();}};
    const release=await collectLedgerReleaseEvidence(countedPool,{schema});
    assert.equal(connections,1);
    assert.equal(release.checksPassed,true);
    assert.equal(release.sameSnapshot,true);
    assert.equal(release.reviewedBodies.match,true);
    assert.equal(release.reviewedBodies.functionResolutionVerified,false);
    assert.equal(release.financialActivationReady,false);
    assert.equal(release.productionReady,false);
    await pool.query("ALTER TABLE ledger_entries DISABLE TRIGGER protect_posted_ledger_entries");
    const disabled=await auditLedgerTriggerContract(admin,{schema});
    assert.equal(disabled.compatible,false);
    const blocked=await collectLedgerReleaseEvidence(admin,{schema});
    assert.equal(blocked.integrity.clean,true);
    assert.equal(blocked.checksPassed,false);
    assert.equal(blocked.financialActivationReady,false);
    assert.deepEqual(disabled.checks.filter(c=>!c.compatible).map(c=>c.name),["protect_posted_ledger_entries"]);
    await pool.query("ALTER TABLE ledger_entries ENABLE TRIGGER protect_posted_ledger_entries");
    await pool.query("CREATE OR REPLACE FUNCTION validate_posted_transaction(p_transaction_id bigint) RETURNS void LANGUAGE plpgsql AS 'BEGIN RETURN; END;'");
    const altered=await collectLedgerReleaseEvidence(admin,{schema});
    assert.equal(altered.integrity.clean,true);
    assert.equal(altered.triggers.compatible,true);
    assert.equal(altered.reviewedBodies.match,false);
    assert.equal(altered.checksPassed,false);
    assert.deepEqual(altered.reviewedBodies.checks.filter(c=>!c.match).map(c=>c.name),["validate_posted_transaction"]);
    await pool.query("DROP TRIGGER ledger_transactions_balance_check ON ledger_transactions");
    const missing=await auditLedgerTriggerContract(admin,{schema});
    assert.equal(missing.compatible,false);
    assert.equal(missing.checks.find(c=>c.name==="ledger_transactions_balance_check").present,false);
  }finally{
    if(pool)await pool.end();
    try{await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);}finally{await admin.end();}
  }
});
test("ledger catalog audit rejects invalid schema before opening connection",async()=>{
  await assert.rejects(auditLedgerTriggerContract({connect(){assert.fail("must not connect");}},{schema:"public;invalid"}),/Invalid ledger schema/);
});

test("combined ledger release evidence rejects incomplete or non-table relations",{skip:!enabled},async()=>{
  const schema="ledger_relation_"+randomUUID().replaceAll("-","");
  const admin=new pg.Pool({connectionString:process.env.DATABASE_URL});
  try{
    await admin.query('CREATE SCHEMA "'+schema+'"');
    await admin.query('CREATE VIEW "'+schema+'".ledger_accounts AS SELECT 1 AS id');
    await admin.query('CREATE TABLE "'+schema+'".ledger_transactions(id bigint)');
    await admin.query('CREATE TABLE "'+schema+'".ledger_entries(id bigint)');
    await assert.rejects(collectLedgerReleaseEvidence(admin,{schema}),/three permanent ordinary tables/);
  }finally{
    try{await admin.query('DROP SCHEMA IF EXISTS "'+schema+'" CASCADE');}finally{await admin.end();}
  }
});
