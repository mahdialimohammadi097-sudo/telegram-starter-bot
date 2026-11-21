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
