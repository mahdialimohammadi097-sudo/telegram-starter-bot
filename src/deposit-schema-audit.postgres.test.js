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
  const fixture=await readFile(new URL("../test/fixtures/verified-deposit-evidence.sql",import.meta.url),"utf8");
  await q(fixture.replace("CREATE TABLE verified_deposit_evidence (","CREATE TABLE "+prefix+"verified_deposit_evidence ("));
  const result=await auditDepositSchema(pool,{schema});
  assert.deepEqual(result.missing,[]);
  assert.deepEqual(result.incompatible,[]);
  assert.equal(result.ready,true);
  const withoutIndex=await auditCombinedDepositPreflight(pool,{schema});
  assert.equal(withoutIndex.catalog.ready,true);
  assert.equal(withoutIndex.assignments.ready,false);
  assert.equal(withoutIndex.ready,false);
  await q(`CREATE UNIQUE INDEX one_active_deposit_wallet ON ${prefix}user_wallet_assignments
    (wallet_id) WHERE status='active' AND assignment_type='deposit'`);
  const combined=await auditCombinedDepositPreflight(pool,{schema});
  assert.equal(combined.ready,true);
  assert.equal(combined.realDepositsEnabled,false);
  assert.equal(combined.scope,"catalog-and-legacy-assignment-only");
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
