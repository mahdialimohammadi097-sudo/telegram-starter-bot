import { isDisposablePostgresTarget } from "../test-support/disposable-postgres-target.js";
import test from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import {readFile} from "node:fs/promises";
import {randomUUID} from "node:crypto";
import {auditDepositSchema} from "./deposit-schema-audit.js";
import {auditCombinedDepositPreflight} from "./legacy-deposit-assignment-audit.js";
const url=process.env.CATALOG_REHEARSAL_URL;
// These tests CREATE and DROP schemas. Never run them against shared or
// production databases, even if CATALOG_REHEARSAL_URL is set by mistake.
function safeDisposableTarget() {
  return isDisposablePostgresTarget(url, "catalog_rehearsal");
}
const skipUnsafeTarget = !safeDisposableTarget();
test("read-only audit queries real PostgreSQL catalog and fails closed on incomplete schema",{skip:skipUnsafeTarget},async()=>{
 const pool=new pg.Pool({connectionString:url});
 const schema="audit_"+randomUUID().replaceAll("-","");
 try {
  await pool.query('CREATE SCHEMA "'+schema+'"');
  const result=await auditDepositSchema(pool,{schema});
  assert.equal(result.ready,false);
  assert.ok(result.missing.includes("users.id"));
  assert.ok(result.incompatible.includes("ledger_transactions.idempotency_key:unique_index"));
  assert.ok(result.incompatible.includes("user_wallet_assignments.wallet_id:foreign_key"));
 } finally {
  await pool.query('DROP SCHEMA IF EXISTS "'+schema+'" CASCADE');
  await pool.end();
 }
});

test("read-only audit accepts complete PostgreSQL ownership and ledger contract",{skip:skipUnsafeTarget},async()=>{
 const pool=new pg.Pool({connectionString:url});
 const schema="audit_ok_"+randomUUID().replaceAll("-","");
 const q=async sql=>pool.query(sql);
 try{
  await q('CREATE SCHEMA "'+schema+'"');
  const prefix='"'+schema+'".';
  await q(`
   CREATE TABLE ${prefix}users(id bigint PRIMARY KEY,status text NOT NULL);
   CREATE TABLE ${prefix}wallets(id bigint PRIMARY KEY,wallet_address text NOT NULL,
     chain_id integer NOT NULL,network text NOT NULL,status text NOT NULL,
     wallet_type text NOT NULL,is_platform_controlled boolean NOT NULL);
   CREATE TABLE ${prefix}user_wallet_assignments(
     id bigint PRIMARY KEY,ended_at timestamptz,
     user_id bigint NOT NULL REFERENCES ${prefix}users(id),
     wallet_id bigint NOT NULL REFERENCES ${prefix}wallets(id),
     assignment_type text NOT NULL,status text NOT NULL);
   CREATE TABLE ${prefix}ledger_accounts(
     id bigint PRIMARY KEY,user_id bigint REFERENCES ${prefix}users(id),
     account_type text NOT NULL,currency text NOT NULL);
   CREATE TABLE ${prefix}ledger_transactions(
     id bigint PRIMARY KEY,idempotency_key text UNIQUE NOT NULL,
     status text NOT NULL,transaction_type text NOT NULL,reference_id text);
   CREATE TABLE ${prefix}ledger_entries(
     transaction_id bigint NOT NULL REFERENCES ${prefix}ledger_transactions(id),
     account_id bigint NOT NULL REFERENCES ${prefix}ledger_accounts(id),
     entry_type text NOT NULL,amount numeric(36,18) NOT NULL,currency text NOT NULL);

  `);
  const migration=await readFile(new URL("../migrations/20261121_verified_deposit_evidence.sql",import.meta.url),"utf8");
  await q(migration.replaceAll("public.",prefix));
  const result=await auditDepositSchema(pool,{schema});
  assert.deepEqual(result.missing,[]);
  assert.deepEqual(result.incompatible,[]);
  assert.equal(result.ready,true);
  // A matching name alone, disabled trigger or PUBLIC grant must not pass.
  await q(`ALTER TABLE ${prefix}verified_deposit_evidence DISABLE TRIGGER verified_deposit_evidence_immutable`);
  assert.ok((await auditDepositSchema(pool,{schema})).incompatible.includes("verified_deposit_evidence:immutable_guard"));
  await q(`ALTER TABLE ${prefix}verified_deposit_evidence ENABLE ALWAYS TRIGGER verified_deposit_evidence_immutable`);
  await q(`GRANT SELECT ON ${prefix}verified_deposit_evidence TO PUBLIC`);
  assert.ok((await auditDepositSchema(pool,{schema})).incompatible.includes("verified_deposit_evidence:immutable_guard"));
  await q(`REVOKE ALL ON ${prefix}verified_deposit_evidence FROM PUBLIC`);
  // Table-level REVOKE does not remove independent column ACLs.
  for(const privilege of ["SELECT","INSERT","UPDATE","REFERENCES"]){
   await q(`GRANT ${privilege} (deposit_address) ON ${prefix}verified_deposit_evidence TO PUBLIC`);
   assert.ok((await auditDepositSchema(pool,{schema})).incompatible.includes("verified_deposit_evidence:immutable_guard"),privilege);
   await q(`REVOKE ${privilege} (deposit_address) ON ${prefix}verified_deposit_evidence FROM PUBLIC`);
   assert.equal((await auditDepositSchema(pool,{schema})).ready,true);
  }
  await q(`GRANT EXECUTE ON FUNCTION ${prefix}reject_verified_deposit_evidence_mutation() TO PUBLIC`);
  assert.ok((await auditDepositSchema(pool,{schema})).incompatible.includes("verified_deposit_evidence:immutable_guard"));
  await q(`REVOKE ALL ON FUNCTION ${prefix}reject_verified_deposit_evidence_mutation() FROM PUBLIC`);
  await q(`CREATE OR REPLACE FUNCTION ${prefix}reject_verified_deposit_evidence_mutation()
    RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $body$ BEGIN RETURN NULL; END $body$`);
  assert.ok((await auditDepositSchema(pool,{schema})).incompatible.includes("verified_deposit_evidence:immutable_guard"));
  await q(`CREATE OR REPLACE FUNCTION ${prefix}reject_verified_deposit_evidence_mutation()
    RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $guard$
BEGIN
 RAISE EXCEPTION 'Verified deposit evidence is immutable' USING ERRCODE='55000';
END
$guard$`);
  assert.equal((await auditDepositSchema(pool,{schema})).ready,true);
  // Unreviewed rewrite rules can suppress writes before the mutation guard runs.
  await q(`CREATE RULE suppress_evidence_insert AS ON INSERT TO ${prefix}verified_deposit_evidence DO INSTEAD NOTHING`);
  assert.ok((await auditDepositSchema(pool,{schema})).incompatible.includes("verified_deposit_evidence:immutable_guard"));
  await q(`DROP RULE suppress_evidence_insert ON ${prefix}verified_deposit_evidence`);
  assert.equal((await auditDepositSchema(pool,{schema})).ready,true);
  await q(`CREATE RULE suppress_evidence_update AS ON UPDATE TO ${prefix}verified_deposit_evidence DO INSTEAD NOTHING`);
  assert.ok((await auditDepositSchema(pool,{schema})).incompatible.includes("verified_deposit_evidence:immutable_guard"));
  await q(`DROP RULE suppress_evidence_update ON ${prefix}verified_deposit_evidence`);
  assert.equal((await auditDepositSchema(pool,{schema})).ready,true);
  const withoutIndex=await auditCombinedDepositPreflight(pool,{schema});
  assert.equal(withoutIndex.catalog.ready,true);
  assert.equal(withoutIndex.assignments.ready,false);
  assert.equal(withoutIndex.ready,false);
  await q(`CREATE UNIQUE INDEX one_active_deposit_wallet ON ${prefix}user_wallet_assignments
    (wallet_id) WHERE status='active' AND assignment_type='deposit'`);
  const missingHistory=await auditCombinedDepositPreflight(pool,{schema});
  assert.equal(missingHistory.catalog.ready,true);
  assert.equal(missingHistory.assignments.ready,true);
  assert.equal(missingHistory.historicalBasicGuardsPresent,false);
  assert.equal(missingHistory.ready,false);
  // Use the reviewed DDL in a disposable schema, retaining public extension prerequisites.
  await q("CREATE EXTENSION IF NOT EXISTS btree_gist WITH SCHEMA public");
  let history=await readFile(new URL("../migrations/20261125_deposit_ownership_history.review.sql",import.meta.url),"utf8");
  for(const name of ["deposit_address_ownership_history","validate_deposit_ownership_wallet_identity","reject_deposit_ownership_history_mutation","wallets","users"]){
   history=history.replaceAll("public."+name,prefix+name);
  }
  await q(history);
  const combined=await auditCombinedDepositPreflight(pool,{schema});
  assert.equal(combined.historicalBasicGuardsPresent,true);
  assert.equal(combined.ready,true);
  assert.equal(combined.realDepositsEnabled,false);
  assert.equal(combined.scope,"catalog-legacy-assignment-and-basic-historical-guards-only");
  await q("ALTER TABLE "+prefix+"deposit_address_ownership_history DISABLE TRIGGER deposit_ownership_history_immutable");
  const disabled=await auditCombinedDepositPreflight(pool,{schema});
  assert.equal(disabled.catalog.ready,true);
  assert.equal(disabled.assignments.ready,true);
  assert.equal(disabled.historicalBasicGuardsPresent,false);
  assert.equal(disabled.ready,false);
  await q("ALTER TABLE "+prefix+"deposit_address_ownership_history ENABLE ALWAYS TRIGGER deposit_ownership_history_immutable");
  assert.equal((await auditCombinedDepositPreflight(pool,{schema})).ready,true);
  // A coercing typmod must not be accepted even with all other checks.
  await q(`ALTER TABLE ${prefix}verified_deposit_evidence ALTER COLUMN block_number TYPE numeric(78,0)`);
  assert.ok((await auditDepositSchema(pool,{schema})).incompatible.includes("verified_deposit_evidence.block_number"));
  await q(`ALTER TABLE ${prefix}verified_deposit_evidence ALTER COLUMN block_number TYPE numeric`);
  assert.equal((await auditDepositSchema(pool,{schema})).ready,true);
  // Removing an actual bound must make the read-only report fail closed.
  const numericConstraints=await pool.query(`SELECT c.conname,pg_catalog.pg_get_expr(c.conbin,c.conrelid,false) AS expression
    FROM pg_constraint c JOIN pg_class t ON t.oid=c.conrelid JOIN pg_namespace n ON n.oid=t.relnamespace
    WHERE n.nspname=$1 AND t.relname='verified_deposit_evidence' AND c.contype='c'`,[schema]);
  const upper=numericConstraints.rows.find(r=>r.expression.startsWith("(amount_base_units <="));
  assert.ok(upper);
  assert.match(upper.conname,/^[a-z_0-9]+$/);
  await q('ALTER TABLE '+prefix+'verified_deposit_evidence DROP CONSTRAINT "'+upper.conname+'"');
  const missingBound=await auditDepositSchema(pool,{schema});
  assert.equal(missingBound.ready,false);
  assert.ok(missingBound.incompatible.includes("verified_deposit_evidence.amount_uint256:check_constraint"));
  const incompleteCombined=await auditCombinedDepositPreflight(pool,{schema});
  assert.equal(incompleteCombined.catalog.ready,false);
  assert.equal(incompleteCombined.assignments.ready,true);
  assert.equal(incompleteCombined.ready,false);
  assert.equal(incompleteCombined.realDepositsEnabled,false);
  // A validated but ineffective constraint with the expected name is not evidence.
  await q('ALTER TABLE '+prefix+'verified_deposit_evidence DROP CONSTRAINT verified_deposit_evidence_event_key_format');
  await q('ALTER TABLE '+prefix+'verified_deposit_evidence ADD CONSTRAINT verified_deposit_evidence_event_key_format CHECK (true)');
  await q('ALTER TABLE '+prefix+'ledger_transactions ALTER COLUMN idempotency_key DROP NOT NULL');
  const weakened=await auditDepositSchema(pool,{schema});
  assert.equal(weakened.ready,false);
  assert.ok(weakened.incompatible.includes("verified_deposit_evidence.verified_deposit_evidence_event_key_format:check_constraint"));
  assert.ok(weakened.incompatible.includes("ledger_transactions.idempotency_key:not_null"));
 }finally{
  await q('DROP SCHEMA IF EXISTS "'+schema+'" CASCADE');
  await pool.end();
 }
});

test("schema audit rejects wrong financial amount precision on real PostgreSQL",{skip:skipUnsafeTarget},async()=>{
 const pool=new pg.Pool({connectionString:url});
 const schema="audit_precision_"+randomUUID().replaceAll("-","");
 try{
  await pool.query('CREATE SCHEMA "'+schema+'"');
  await pool.query('CREATE TABLE "'+schema+'".ledger_entries (amount numeric(36,8))');
  const result=await auditDepositSchema(pool,{schema});
  assert.equal(result.ready,false);
  assert.ok(result.incompatible.includes("ledger_entries.amount"));
 }finally{
  await pool.query('DROP SCHEMA IF EXISTS "'+schema+'" CASCADE');
  await pool.end();
 }
});

test("schema audit rejects insufficient total precision even when scale is correct",{skip:skipUnsafeTarget},async()=>{
 const pool=new pg.Pool({connectionString:url});
 const schema="audit_capacity_"+randomUUID().replaceAll("-","");
 try{
  await pool.query('CREATE SCHEMA "'+schema+'"');
  await pool.query('CREATE TABLE "'+schema+'".ledger_entries (amount numeric(20,18))');
  const result=await auditDepositSchema(pool,{schema});
  assert.equal(result.ready,false);
  assert.ok(result.incompatible.includes("ledger_entries.amount"));
 }finally{
  await pool.query('DROP SCHEMA IF EXISTS "'+schema+'" CASCADE');
  await pool.end();
 }
});

test("schema audit rejects partial unique indexes for deposit event identity",{skip:skipUnsafeTarget},async()=>{
 const pool=new pg.Pool({connectionString:url});
 const schema="audit_partial_"+randomUUID().replaceAll("-","");
 try{
  await pool.query('CREATE SCHEMA "'+schema+'"');
  await pool.query('CREATE TABLE "'+schema+'".verified_deposit_evidence (event_key text, block_hash text, block_number numeric(78,0), token_contract text, deposit_address text, amount_base_units numeric(78,0))');
  await pool.query('CREATE UNIQUE INDEX ON "'+schema+'".verified_deposit_evidence(event_key) WHERE event_key IS NOT NULL');
  const result=await auditDepositSchema(pool,{schema});
  assert.equal(result.ready,false);
  assert.ok(result.incompatible.includes("verified_deposit_evidence.event_key:unique_index"));
 }finally{
  await pool.query('DROP SCHEMA IF EXISTS "'+schema+'" CASCADE');
  await pool.end();
 }
});

test("schema audit refuses NOT VALID ownership foreign keys",{skip:skipUnsafeTarget},async()=>{
 const pool=new pg.Pool({connectionString:url});
 const schema="audit_unvalidated_"+randomUUID().replaceAll("-","");
 try{
  await pool.query('CREATE SCHEMA "'+schema+'"');
  await pool.query('CREATE TABLE "'+schema+'".users (id bigint PRIMARY KEY)');
  await pool.query('CREATE TABLE "'+schema+'".user_wallet_assignments (user_id bigint)');
  await pool.query('ALTER TABLE "'+schema+'".user_wallet_assignments ADD CONSTRAINT owner_fk FOREIGN KEY (user_id) REFERENCES "'+schema+'".users(id) NOT VALID');
  const result=await auditDepositSchema(pool,{schema});
  assert.equal(result.ready,false);
  assert.ok(result.incompatible.includes("user_wallet_assignments.user_id:foreign_key"));
 }finally{
  await pool.query('DROP SCHEMA IF EXISTS "'+schema+'" CASCADE');
  await pool.end();
 }
});

test("schema audit rejects nullable evidence fields in PostgreSQL",{skip:skipUnsafeTarget},async()=>{
 const pool=new pg.Pool({connectionString:url});
 const schema="audit_nullable_"+randomUUID().replaceAll("-","");
 try{
  await pool.query('CREATE SCHEMA "'+schema+'"');
  await pool.query('CREATE TABLE "'+schema+'".verified_deposit_evidence (event_key text, block_hash text, block_number numeric(78,0), token_contract text, deposit_address text, amount_base_units numeric(78,0))');
  const result=await auditDepositSchema(pool,{schema});
  assert.equal(result.ready,false);
  assert.ok(result.incompatible.includes("verified_deposit_evidence.event_key:not_null"));
  assert.ok(result.incompatible.includes("verified_deposit_evidence.amount_base_units:not_null"));
 }finally{
  await pool.query('DROP SCHEMA IF EXISTS "'+schema+'" CASCADE');
  await pool.end();
 }
});


test("schema audit rejects a text platform-control flag instead of boolean",{skip:skipUnsafeTarget},async()=>{
 const pool=new pg.Pool({connectionString:url});
 const schema="audit_owner_type_"+randomUUID().replaceAll("-","");
 try{
  await pool.query('CREATE SCHEMA "'+schema+'"');
  await pool.query('CREATE TABLE "'+schema+'".wallets (is_platform_controlled text NOT NULL)');
  const result=await auditDepositSchema(pool,{schema});
  assert.equal(result.ready,false);
  assert.ok(result.incompatible.includes("wallets.is_platform_controlled"));
 }finally{
  await pool.query('DROP SCHEMA IF EXISTS "'+schema+'" CASCADE');
  await pool.end();
 }
});


test("schema audit rejects nullable wallet ownership fields",{skip:skipUnsafeTarget},async()=>{
 const pool=new pg.Pool({connectionString:url});
 const schema="audit_owner_null_"+randomUUID().replaceAll("-","");
 try{
  await pool.query('CREATE SCHEMA "'+schema+'"');
  await pool.query('CREATE TABLE "'+schema+'".wallets (wallet_address text, is_platform_controlled boolean)');
  await pool.query('CREATE TABLE "'+schema+'".user_wallet_assignments (user_id bigint, ended_at timestamptz)');
  const result=await auditDepositSchema(pool,{schema});
  assert.equal(result.ready,false);
  for(const name of ["wallets.wallet_address:not_null","wallets.is_platform_controlled:not_null","user_wallet_assignments.user_id:not_null"])
   assert.ok(result.incompatible.includes(name),name);
  assert.ok(!result.incompatible.includes("user_wallet_assignments.ended_at:not_null"));
 }finally{
  await pool.query('DROP SCHEMA IF EXISTS "'+schema+'" CASCADE');
  await pool.end();
 }
});

test("schema audit rejects an existing evidence table without format constraints",{skip:skipUnsafeTarget},async()=>{
 const pool=new pg.Pool({connectionString:url});
 const schema="audit_checks_missing_"+randomUUID().replaceAll("-","");
 try {
  await pool.query('CREATE SCHEMA "'+schema+'"');
  await pool.query('CREATE TABLE "'+schema+'".verified_deposit_evidence (event_key text PRIMARY KEY, block_hash text NOT NULL, block_number numeric(78,0) NOT NULL, token_contract text NOT NULL, deposit_address text NOT NULL, amount_base_units numeric(78,0) NOT NULL)');
  const report=await auditDepositSchema(pool,{schema});
  assert.equal(report.ready,false);
  assert.ok(report.incompatible.includes("verified_deposit_evidence.verified_deposit_evidence_event_key_format:check_constraint"));
  assert.ok(report.incompatible.includes("verified_deposit_evidence.verified_deposit_evidence_address_format:check_constraint"));
 }finally{
  await pool.query('DROP SCHEMA IF EXISTS "'+schema+'" CASCADE');
  await pool.end();
 }
});

test("schema audit rejects NOT VALID evidence format constraints",{skip:skipUnsafeTarget},async()=>{
 const pool=new pg.Pool({connectionString:url});
 const schema="audit_checks_invalid_"+randomUUID().replaceAll("-","");
 try {
  await pool.query('CREATE SCHEMA "'+schema+'"');
  await pool.query('CREATE TABLE "'+schema+'".verified_deposit_evidence (event_key text PRIMARY KEY)');
  await pool.query('ALTER TABLE "'+schema+'".verified_deposit_evidence ADD CONSTRAINT verified_deposit_evidence_event_key_format CHECK (event_key <> \'\') NOT VALID');
  const report=await auditDepositSchema(pool,{schema});
  assert.equal(report.ready,false);
  assert.ok(report.incompatible.includes("verified_deposit_evidence.verified_deposit_evidence_event_key_format:check_constraint"));
 }finally{
  await pool.query('DROP SCHEMA IF EXISTS "'+schema+'" CASCADE');
  await pool.end();
 }
});

test("schema audit rejects deferrable unique constraints as deposit conflict arbiters",{skip:skipUnsafeTarget},async()=>{
 const pool=new pg.Pool({connectionString:url});
 const schema="audit_deferred_"+randomUUID().replaceAll("-","");
 const prefix='"'+schema+'".';
 try {
  await pool.query('CREATE SCHEMA "'+schema+'"');
  await pool.query('CREATE TABLE '+prefix+'verified_deposit_evidence (event_key text UNIQUE DEFERRABLE INITIALLY IMMEDIATE)');
  await pool.query('CREATE TABLE '+prefix+'ledger_transactions (idempotency_key text UNIQUE DEFERRABLE INITIALLY DEFERRED)');
  const report=await auditDepositSchema(pool,{schema});
  assert.equal(report.ready,false);
  assert.ok(report.incompatible.includes("verified_deposit_evidence.event_key:unique_index"));
  assert.ok(report.incompatible.includes("ledger_transactions.idempotency_key:unique_index"));
 } finally {
  await pool.query('DROP SCHEMA IF EXISTS "'+schema+'" CASCADE');
  await pool.end();
 }
});

test("schema audit rejects composite FK masquerading as independent ownership link",{skip:skipUnsafeTarget},async()=>{
 const pool=new pg.Pool({connectionString:url});
 const schema="audit_composite_"+randomUUID().replaceAll("-","");
 const prefix='"'+schema+'".';
 try {
  await pool.query('CREATE SCHEMA "'+schema+'"');
  await pool.query('CREATE TABLE '+prefix+'users (id bigint, tenant_id bigint, UNIQUE(id,tenant_id))');
  await pool.query('CREATE TABLE '+prefix+'user_wallet_assignments (user_id bigint, tenant_id bigint, FOREIGN KEY(user_id,tenant_id) REFERENCES '+prefix+'users(id,tenant_id))');
  const report=await auditDepositSchema(pool,{schema});
  assert.equal(report.ready,false);
  assert.ok(report.incompatible.includes("user_wallet_assignments.user_id:foreign_key"));
 } finally {
  await pool.query('DROP SCHEMA IF EXISTS "'+schema+'" CASCADE');
  await pool.end();
 }
});

test("schema audit refuses views, unlogged relations and both sides of table inheritance",{skip:skipUnsafeTarget},async()=>{
 const pool=new pg.Pool({connectionString:url});
 const schema="audit_relation_"+randomUUID().replaceAll("-","");
 const prefix='"'+schema+'".';
 try{
  await pool.query('CREATE SCHEMA "'+schema+'"');
  await pool.query(`
   CREATE VIEW ${prefix}users AS SELECT 1::bigint AS id,'active'::text AS status;
   CREATE UNLOGGED TABLE ${prefix}wallets(id bigint PRIMARY KEY);
   CREATE TABLE ${prefix}ledger_accounts(id bigint NOT NULL);
   CREATE TABLE ${prefix}ledger_entries(amount numeric(36,18) NOT NULL) INHERITS (${prefix}ledger_accounts);
   CREATE TABLE ${prefix}ledger_transactions(id bigint PRIMARY KEY,idempotency_key text UNIQUE NOT NULL);
  `);
  const report=await auditDepositSchema(pool,{schema});
  assert.equal(report.ready,false);
  for(const field of ["users.id","wallets.id","ledger_accounts.id","ledger_entries.amount"])
   assert.ok(report.missing.includes(field),field);
  assert.ok(!report.missing.includes("ledger_transactions.id"));
  assert.ok(!report.incompatible.includes("ledger_transactions.idempotency_key:unique_index"));
 }finally{
  await pool.query('DROP SCHEMA IF EXISTS "'+schema+'" CASCADE');
  await pool.end();
 }
});
