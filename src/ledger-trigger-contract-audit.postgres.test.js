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
    assert.equal(clean.unexpectedTriggerCount,0);
    assert.equal(clean.functionBodiesVerified,false);
    assert.equal(clean.productionReady,false);
    let connections=0;
    const countedPool={async connect(){connections++;return admin.connect();}};
    const release=await collectLedgerReleaseEvidence(countedPool,{schema});
    assert.equal(connections,1);
    assert.equal(release.checksPassed,true);
    assert.equal(release.sameSnapshot,true);
    assert.deepEqual(release.relations,{inheritanceFree:true,rewriteRuleFree:true,rowSecurityFree:true,rowPolicyFree:true});
    assert.equal(release.generatedIds.checks.length,3);
    assert.equal(release.generatedIds.compatible,true);
    assert.equal(release.generatedIds.currentSequencePositionVerified,false);
    // Simulate a caller with an explicit non-catalog-first path and an
    // operator that would hide catalog rows before the audit pins resolution.
    await pool.query(`CREATE FUNCTION "${schema}".fixture_name_equal(name,name)
      RETURNS boolean LANGUAGE sql IMMUTABLE AS 'SELECT false';
      CREATE OPERATOR "${schema}".= (LEFTARG=name, RIGHTARG=name,
        FUNCTION="${schema}".fixture_name_equal)`);
    const drifted=await pool.connect();
    try{
      await drifted.query(`SET search_path = "${schema}",pg_catalog`);
      assert.equal((await drifted.query("SELECT 'a'::name = 'a'::name AS equal")).rows[0].equal,false);
      const adapter={connect:async()=>({query:drifted.query.bind(drifted),release(error){assert.equal(error,undefined);}})};
      assert.equal((await collectLedgerReleaseEvidence(adapter,{schema})).checksPassed,true);
      const standalone=await auditLedgerTriggerContract(adapter,{schema});
      assert.equal(standalone.compatible,true);
      assert.equal(standalone.checks.length,4);
      assert.equal(standalone.functionBodiesVerified,false);
      assert.equal(standalone.productionReady,false);
      // SET LOCAL must not permanently change the caller's search path.
      assert.equal((await drifted.query("SELECT 'a'::name = 'a'::name AS equal")).rows[0].equal,false);
    }finally{
      drifted.release(true);
      await pool.query(`DROP OPERATOR "${schema}".= (name,name);
        DROP FUNCTION "${schema}".fixture_name_equal(name,name)`);
    }
    await pool.query("ALTER TABLE ledger_entries ALTER COLUMN id SET DEFAULT 1");
    const wrongDefault=await collectLedgerReleaseEvidence(admin,{schema});
    assert.equal(wrongDefault.integrity.clean,true);
    assert.equal(wrongDefault.generatedIds.compatible,false);
    assert.equal(wrongDefault.checksPassed,false);
    await pool.query("ALTER TABLE ledger_entries ALTER COLUMN id SET DEFAULT nextval('ledger_transactions_id_seq'::regclass)");
    assert.equal((await collectLedgerReleaseEvidence(admin,{schema})).generatedIds.compatible,false);
    await pool.query("ALTER TABLE ledger_entries ALTER COLUMN id SET DEFAULT nextval('ledger_entries_id_seq'::regclass)");
    await pool.query("ALTER SEQUENCE ledger_entries_id_seq CYCLE");
    assert.equal((await collectLedgerReleaseEvidence(admin,{schema})).generatedIds.compatible,false);
    await pool.query("ALTER SEQUENCE ledger_entries_id_seq NO CYCLE");
    await pool.query("ALTER SEQUENCE ledger_entries_id_seq OWNED BY NONE");
    assert.equal((await collectLedgerReleaseEvidence(admin,{schema})).generatedIds.compatible,false);
    await pool.query("ALTER SEQUENCE ledger_entries_id_seq OWNED BY ledger_entries.id");
    assert.equal((await collectLedgerReleaseEvidence(admin,{schema})).checksPassed,true);
    assert.equal(release.identityConstraints.checks.length,6);
    assert.equal(release.identityConstraints.compatible,true);
    assert.equal(release.foreignKeys.checks.length,3);
    assert.equal(release.foreignKeys.compatible,true);
    assert.equal(release.columnContract.checks.length,20);
    assert.equal(release.columnContract.compatible,true);
    assert.equal(release.columnContract.idempotencyNotNull,false);
    assert.deepEqual([release.columnContract.storagePrecision,release.columnContract.storageScale],[36,18]);
    assert.equal(release.amountConstraint.positiveAmount,true);
    assert.equal(release.valueConstraints.compatible,true);
    assert.equal(release.valueConstraints.checks.length,2);
    await pool.query("ALTER TABLE ledger_entries DROP CONSTRAINT ledger_entries_entry_type_check");
    const missingDirection=await collectLedgerReleaseEvidence(admin,{schema});
    assert.equal(missingDirection.integrity.clean,true);
    assert.equal(missingDirection.valueConstraints.compatible,false);
    assert.equal(missingDirection.checksPassed,false);
    await pool.query("ALTER TABLE ledger_entries ADD CHECK(entry_type IN ('de bit','credit'))");
    assert.equal((await collectLedgerReleaseEvidence(admin,{schema})).valueConstraints.compatible,false);
    await pool.query("ALTER TABLE ledger_entries DROP CONSTRAINT ledger_entries_entry_type_check");
    await pool.query("ALTER TABLE ledger_entries ADD CHECK(entry_type IN ('debit','credit'))");
    await pool.query("ALTER TABLE ledger_transactions DROP CONSTRAINT ledger_transactions_status_check");
    await pool.query("ALTER TABLE ledger_transactions ADD CHECK(status IN ('pending','posted','reversed','unknown'))");
    assert.equal((await collectLedgerReleaseEvidence(admin,{schema})).valueConstraints.compatible,false);
    await pool.query("ALTER TABLE ledger_transactions DROP CONSTRAINT ledger_transactions_status_check");
    await pool.query("ALTER TABLE ledger_transactions ADD CHECK(status IN ('pending','posted','reversed')) NOT VALID");
    assert.equal((await collectLedgerReleaseEvidence(admin,{schema})).valueConstraints.compatible,false);
    await pool.query("ALTER TABLE ledger_transactions VALIDATE CONSTRAINT ledger_transactions_status_check");
    assert.equal((await collectLedgerReleaseEvidence(admin,{schema})).checksPassed,true);
    await pool.query("ALTER TABLE ledger_entries ALTER COLUMN amount TYPE numeric(36,4)");
    await assert.rejects(collectLedgerReleaseEvidence(admin,{schema}),/Ledger column contract incompatible/);
    await pool.query("ALTER TABLE ledger_entries ALTER COLUMN amount TYPE numeric(36,18)");
    await pool.query("ALTER TABLE ledger_entries ALTER COLUMN entry_type DROP NOT NULL");
    await assert.rejects(collectLedgerReleaseEvidence(admin,{schema}),/Ledger column contract incompatible/);
    await pool.query("ALTER TABLE ledger_entries ALTER COLUMN entry_type SET NOT NULL");
    await pool.query("ALTER TABLE ledger_transactions ALTER COLUMN idempotency_key SET NOT NULL");
    assert.equal((await collectLedgerReleaseEvidence(admin,{schema})).columnContract.idempotencyNotNull,true);
    await pool.query("ALTER TABLE ledger_transactions ALTER COLUMN idempotency_key DROP NOT NULL");
    await pool.query("ALTER TABLE ledger_entries DROP CONSTRAINT ledger_entries_amount_check");
    const missingAmountCheck=await collectLedgerReleaseEvidence(admin,{schema});
    assert.equal(missingAmountCheck.integrity.clean,true);
    assert.equal(missingAmountCheck.amountConstraint.compatible,false);
    assert.equal(missingAmountCheck.checksPassed,false);
    await pool.query("ALTER TABLE ledger_entries ADD CHECK(amount >= 0)");
    assert.equal((await collectLedgerReleaseEvidence(admin,{schema})).amountConstraint.compatible,false);
    await pool.query("ALTER TABLE ledger_entries DROP CONSTRAINT ledger_entries_amount_check");
    await pool.query("ALTER TABLE ledger_entries ADD CHECK(amount > 0) NOT VALID");
    assert.equal((await collectLedgerReleaseEvidence(admin,{schema})).amountConstraint.compatible,false);
    await pool.query("ALTER TABLE ledger_entries VALIDATE CONSTRAINT ledger_entries_amount_check");
    assert.equal((await collectLedgerReleaseEvidence(admin,{schema})).checksPassed,true);
    await pool.query("ALTER TABLE ledger_entries DROP CONSTRAINT ledger_entries_account_id_fkey");
    const missingReference=await collectLedgerReleaseEvidence(admin,{schema});
    assert.equal(missingReference.integrity.clean,true);
    assert.equal(missingReference.foreignKeys.compatible,false);
    assert.equal(missingReference.checksPassed,false);
    assert.deepEqual(missingReference.foreignKeys.checks.filter(x=>!x.compatible).map(x=>x.column),["account_id"]);
    await pool.query("ALTER TABLE ledger_entries ADD FOREIGN KEY(account_id) REFERENCES ledger_accounts(id) NOT VALID");
    assert.equal((await collectLedgerReleaseEvidence(admin,{schema})).foreignKeys.compatible,false);
    await pool.query("ALTER TABLE ledger_entries VALIDATE CONSTRAINT ledger_entries_account_id_fkey");
    assert.equal((await collectLedgerReleaseEvidence(admin,{schema})).checksPassed,true);
    await pool.query("ALTER TABLE ledger_entries DROP CONSTRAINT ledger_entries_account_id_fkey");
    await pool.query("ALTER TABLE ledger_entries ADD FOREIGN KEY(account_id) REFERENCES ledger_accounts(id) ON DELETE CASCADE");
    assert.equal((await collectLedgerReleaseEvidence(admin,{schema})).foreignKeys.compatible,false);
    await pool.query("ALTER TABLE ledger_entries DROP CONSTRAINT ledger_entries_account_id_fkey");
    await pool.query("ALTER TABLE ledger_entries ADD FOREIGN KEY(account_id) REFERENCES ledger_accounts(id)");
    assert.equal((await collectLedgerReleaseEvidence(admin,{schema})).checksPassed,true);
    // A clean empty ledger must not hide the loss of replay protection.
    await pool.query("ALTER TABLE ledger_transactions DROP CONSTRAINT ledger_transactions_idempotency_key_key");
    const missingIdentity=await collectLedgerReleaseEvidence(admin,{schema});
    assert.equal(missingIdentity.integrity.clean,true);
    assert.equal(missingIdentity.identityConstraints.compatible,false);
    assert.equal(missingIdentity.checksPassed,false);
    assert.deepEqual(missingIdentity.identityConstraints.checks.filter(x=>!x.compatible).map(x=>x.columns),[["idempotency_key"]]);
    await pool.query("ALTER TABLE ledger_transactions ADD UNIQUE(idempotency_key) DEFERRABLE INITIALLY DEFERRED");
    assert.equal((await collectLedgerReleaseEvidence(admin,{schema})).identityConstraints.compatible,false);
    await pool.query("ALTER TABLE ledger_transactions DROP CONSTRAINT ledger_transactions_idempotency_key_key");
    await pool.query("ALTER TABLE ledger_transactions ADD UNIQUE(idempotency_key)");
    assert.equal((await collectLedgerReleaseEvidence(admin,{schema})).checksPassed,true);
    // Empty extra relations and rules must be detected independently of row integrity.
    await pool.query("CREATE TABLE extra_ledger_child () INHERITS (ledger_entries)");
    await assert.rejects(collectLedgerReleaseEvidence(admin,{schema}),/unreviewed inheritance or rewrite rules/);
    await pool.query("DROP TABLE extra_ledger_child");
    await pool.query("CREATE RULE extra_ledger_rule AS ON UPDATE TO ledger_accounts DO INSTEAD NOTHING");
    await assert.rejects(collectLedgerReleaseEvidence(admin,{schema}),/unreviewed inheritance or rewrite rules/);
    await pool.query("DROP RULE extra_ledger_rule ON ledger_accounts");
    await pool.query("ALTER TABLE ledger_entries ENABLE ROW LEVEL SECURITY");
    await assert.rejects(collectLedgerReleaseEvidence(admin,{schema}),/unreviewed row security configuration/);
    await pool.query("ALTER TABLE ledger_entries FORCE ROW LEVEL SECURITY");
    await pool.query("ALTER TABLE ledger_entries DISABLE ROW LEVEL SECURITY");
    await assert.rejects(collectLedgerReleaseEvidence(admin,{schema}),/unreviewed row security configuration/);
    await pool.query("ALTER TABLE ledger_entries NO FORCE ROW LEVEL SECURITY");
    await pool.query("CREATE POLICY dormant_fixture ON ledger_entries USING (false)");
    await assert.rejects(collectLedgerReleaseEvidence(admin,{schema}),/unreviewed row security configuration/);
    await pool.query("DROP POLICY dormant_fixture ON ledger_entries");
    assert.equal((await collectLedgerReleaseEvidence(admin,{schema})).checksPassed,true);
    assert.equal(release.reviewedBodies.match,true);
    assert.equal(release.reviewedBodies.functionResolutionVerified,false);
    assert.equal(release.financialActivationReady,false);
    assert.equal(release.productionReady,false);
    // A reviewed trigger set must not silently accept additional executable hooks.
    await pool.query("CREATE TRIGGER extra_account_hook BEFORE UPDATE ON ledger_accounts FOR EACH ROW EXECUTE FUNCTION protect_posted_transaction()");
    await pool.query("CREATE TRIGGER extra_entry_hook BEFORE UPDATE ON ledger_entries FOR EACH ROW EXECUTE FUNCTION protect_posted_entries()");
    await pool.query("ALTER TABLE ledger_accounts DISABLE TRIGGER extra_account_hook");
    const extra=await collectLedgerReleaseEvidence(admin,{schema});
    assert.equal(extra.integrity.clean,true);
    assert.equal(extra.reviewedBodies.match,true);
    assert.equal(extra.triggers.checks.every(c=>c.compatible),true);
    assert.equal(extra.triggers.unexpectedTriggerCount,2);
    assert.equal(extra.triggers.compatible,false);
    assert.equal(extra.checksPassed,false);
    assert.equal(extra.financialActivationReady,false);
    assert.equal(JSON.stringify(extra).includes("extra_account_hook"),false);
    await pool.query("DROP TRIGGER extra_account_hook ON ledger_accounts");
    await pool.query("DROP TRIGGER extra_entry_hook ON ledger_entries");
    assert.equal((await collectLedgerReleaseEvidence(admin,{schema})).checksPassed,true);
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
