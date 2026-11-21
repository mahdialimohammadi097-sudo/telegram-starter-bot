import test from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import {readFile} from "node:fs/promises";
import {randomUUID} from "node:crypto";
import {auditDepositSchema} from "./deposit-schema-audit.js";
const url=process.env.CATALOG_REHEARSAL_URL;
test("read-only audit queries real PostgreSQL catalog and fails closed on incomplete schema",{skip:!url},async()=>{
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

test("read-only audit accepts complete PostgreSQL ownership and ledger contract",{skip:!url},async()=>{
 const pool=new pg.Pool({connectionString:url});
 const schema="audit_ok_"+randomUUID().replaceAll("-","");
 const q=async sql=>pool.query(sql);
 try{
  await q('CREATE SCHEMA "'+schema+'"');
  const prefix='"'+schema+'".';
  await q(`
   CREATE TABLE ${prefix}users(id bigint PRIMARY KEY,status text NOT NULL);
   CREATE TABLE ${prefix}wallets(id bigint PRIMARY KEY,wallet_address text NOT NULL,
     chain_id integer NOT NULL,network text NOT NULL,status text NOT NULL);
   CREATE TABLE ${prefix}user_wallet_assignments(
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
   CREATE TABLE ${prefix}verified_deposit_evidence(
     event_key text PRIMARY KEY,block_hash text NOT NULL,
     block_number numeric(78,0) NOT NULL,token_contract text NOT NULL,
     deposit_address text NOT NULL,amount_base_units numeric(78,0) NOT NULL);
  `);
  const result=await auditDepositSchema(pool,{schema});
  assert.deepEqual(result.missing,[]);
  assert.deepEqual(result.incompatible,[]);
  assert.equal(result.ready,true);
 }finally{
  await q('DROP SCHEMA IF EXISTS "'+schema+'" CASCADE');
  await pool.end();
 }
});

test("schema audit rejects wrong financial amount precision on real PostgreSQL",{skip:!url},async()=>{
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

test("schema audit rejects insufficient total precision even when scale is correct",{skip:!url},async()=>{
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

test("schema audit rejects partial unique indexes for deposit event identity",{skip:!url},async()=>{
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

test("schema audit refuses NOT VALID ownership foreign keys",{skip:!url},async()=>{
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

test("schema audit rejects nullable evidence fields in PostgreSQL",{skip:!url},async()=>{
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
