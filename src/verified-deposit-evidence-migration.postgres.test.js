import test from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import {readFile} from "node:fs/promises";
import {randomUUID} from "node:crypto";

const url=process.env.CATALOG_REHEARSAL_URL;
function disposable() {
 if(!url || process.env.PROFINO_DISPOSABLE_POSTGRES!=="yes") return false;
 try { const u=new URL(url); return ["localhost","127.0.0.1","::1"].includes(u.hostname)&&u.pathname==="/catalog_rehearsal"; }
 catch { return false; }
}
test("proposed evidence migration creates audited catalog and fails closed on replay",
 {skip:!disposable()},async()=>{
 const pool=new pg.Pool({connectionString:url});
 const schema="evidence_migration_"+randomUUID().replaceAll("-","");
 const migration=await readFile(new URL("../migrations/20261123_verified_deposit_evidence.review.sql",import.meta.url),"utf8");
 const scoped=migration.replace("public.verified_deposit_evidence",'"'+schema+'".verified_deposit_evidence');
 assert.notEqual(scoped,migration);
 try {
  await pool.query('CREATE SCHEMA "'+schema+'"');
  await pool.query(scoped);
  const columns=await pool.query(`SELECT column_name,data_type,numeric_precision,numeric_scale,is_nullable
    FROM information_schema.columns WHERE table_schema=$1 AND table_name='verified_deposit_evidence'`,[schema]);
  const map=new Map(columns.rows.map(r=>[r.column_name,r]));
  for(const name of ["event_key","block_hash","block_number","token_contract","deposit_address","amount_base_units"])
   assert.equal(map.get(name)?.is_nullable,"NO",name);
  for(const name of ["block_number","amount_base_units"]) {
   assert.equal(Number(map.get(name).numeric_precision),78);
   assert.equal(Number(map.get(name).numeric_scale),0);
  }
  const constraints=await pool.query(`SELECT conname,contype,convalidated FROM pg_constraint
   WHERE conrelid=($1::text || '.verified_deposit_evidence')::regclass`,[schema]);
  const named=new Map(constraints.rows.map(r=>[r.conname,r]));
  for(const name of ["event_key_format","block_hash_format","token_format","address_format"])
   assert.equal(named.get("verified_deposit_evidence_"+name)?.convalidated,true,name);
  const indexes=await pool.query(`SELECT i.indisunique,i.indisvalid,i.indisready,i.indnkeyatts,
    i.indpred IS NULL AS unfiltered,a.attname AS column_name FROM pg_index i
    JOIN pg_class t ON t.oid=i.indrelid JOIN pg_namespace n ON n.oid=t.relnamespace
    JOIN pg_attribute a ON a.attrelid=t.oid AND a.attnum=i.indkey[0]
    WHERE n.nspname=$1 AND t.relname='verified_deposit_evidence'`,[schema]);
  assert.ok(indexes.rows.some(r=>r.indisunique&&r.indisvalid&&r.indisready&&r.unfiltered&&Number(r.indnkeyatts)===1&&r.column_name==="event_key"));
  await assert.rejects(pool.query(scoped),/already exists/);
 }finally {
  await pool.query('DROP SCHEMA IF EXISTS "'+schema+'" CASCADE');
  await pool.end();
 }
});
