import test from "node:test";
import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";
import {readFile} from "node:fs/promises";
import pg from "pg";
import {isDisposablePostgresTarget} from "../test-support/disposable-postgres-target.js";

const url=process.env.CATALOG_REHEARSAL_URL;
const max=((1n<<256n)-1n).toString();
const beyond=(1n<<256n).toString();

test("reviewed history migration enforces bounds, interval exclusion and immutability",{
 skip:!isDisposablePostgresTarget(url,"catalog_rehearsal"),timeout:30000
},async()=>{
 const schema="history_migration_"+randomUUID().replaceAll("-","");
 const prefix='"'+schema+'".';
 const table=prefix+"deposit_address_ownership_history";
 const address="0x"+"a".repeat(40),other="0x"+"b".repeat(40);
 const pool=new pg.Pool({connectionString:url,max:1,connectionTimeoutMillis:5000});
 const client=await pool.connect();
 try{
  // Extension provisioning is test-only, separate from the reviewed migration.
  await client.query("CREATE EXTENSION IF NOT EXISTS btree_gist WITH SCHEMA public");
  await client.query('CREATE SCHEMA "'+schema+'"');
  await client.query("CREATE TABLE "+prefix+"wallets(id bigint PRIMARY KEY,chain_id bigint NOT NULL,wallet_address text NOT NULL,is_platform_controlled boolean NOT NULL)");
  await client.query("CREATE TABLE "+prefix+"users(id bigint PRIMARY KEY)");
  await client.query("INSERT INTO "+prefix+"wallets VALUES (1,56,$1,true),(2,56,$1,true),(3,56,$2,true)",[address,other]);
  await client.query("INSERT INTO "+prefix+"users VALUES (11),(12)");
  const sql=await readFile(new URL("../migrations/20261125_deposit_ownership_history.review.sql",import.meta.url),"utf8");
  let rehearsal=sql;
  for(const name of ["deposit_address_ownership_history","validate_deposit_ownership_wallet_identity","reject_deposit_ownership_history_mutation","wallets","users"]){
   rehearsal=rehearsal.replaceAll("public."+name,prefix+name);
  }
  // Source schema drift must be rejected before creating the history table.
  await client.query("ALTER TABLE "+prefix+"wallets ALTER COLUMN chain_id TYPE text USING chain_id::text");
  await assert.rejects(client.query(rehearsal),/source column prerequisites not confirmed/);
  await client.query("ROLLBACK");
  assert.equal((await client.query("SELECT pg_catalog.to_regclass($1) AS relation",[table])).rows[0].relation,null);
  await client.query("ALTER TABLE "+prefix+"wallets ALTER COLUMN chain_id TYPE bigint USING chain_id::bigint");
  await client.query(rehearsal);
  const insert=(wallet,user,addr,start,end)=>client.query(
   "INSERT INTO "+table+"(wallet_id,user_id,chain_id,wallet_address,start_block,end_block,verified_source) VALUES ($1,$2,56,$3,$4,$5,'disposable-review')",
   [wallet,user,addr,start,end]);
  await insert(1,11,address,"100","200");
  await assert.rejects(insert(2,12,address,"150","250"),{code:"23P01"});
  await assert.rejects(insert(1,12,address,"150","180"),{code:"23P01"});
  await insert(2,12,address,"200","300");
  await insert(2,12,address,"300","400");
  await assert.rejects(insert(2,12,address,"400",null),{code:"23502"});
  // Distinct start isolates the exclusion constraint from the unique start constraint.
  await assert.rejects(insert(1,11,address,"310","400"),{code:"23P01"});
  // A repeated start also violates exclusion; PostgreSQL can report either.
  await assert.rejects(insert(1,11,address,"300","400"),
   error=>["23505","23P01"].includes(error.code));
  await assert.rejects(insert(3,11,address,"1","2"),/identity mismatch/);
  for(const [start,end] of [["NaN","2"],[beyond,max],["-1","2"],["1","NaN"],["1",beyond],["1","1"],["1.2","3"],["1","3.4"],["-0.1","2"],["1.0","3"],["1","3.0"]]){
   await assert.rejects(insert(3,11,other,start,end),{code:"23514"});
  }
  await insert(3,11,other,(BigInt(max)-1n).toString(),max);
  await assert.rejects(client.query("UPDATE "+table+" SET user_id=12 WHERE wallet_id=1"),/immutable/);
  await assert.rejects(client.query("DELETE FROM "+table+" WHERE wallet_id=1"),/immutable/);
  await assert.rejects(client.query("TRUNCATE "+table),/immutable/);
  assert.equal((await client.query("SELECT count(*)::int AS n FROM "+table)).rows[0].n,4);
  const triggers=await client.query("SELECT tgname,tgenabled FROM pg_catalog.pg_trigger WHERE tgrelid=$1::regclass AND NOT tgisinternal",[table]);
  assert.equal(triggers.rows.length,3);
  assert.ok(triggers.rows.every(r=>r.tgenabled==="A"));
  await assert.rejects(client.query(rehearsal),{code:"42P07"});
  await client.query("ROLLBACK");
  assert.equal((await client.query("SELECT count(*)::int AS n FROM "+table)).rows[0].n,4);
 }finally{
  try{
   await client.query("ROLLBACK");
   await client.query('DROP SCHEMA IF EXISTS "'+schema+'" CASCADE');
  }finally{client.release();await pool.end();}
 }
});
