import test from "node:test";
import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";
import {readFile} from "node:fs/promises";
import pg from "pg";
import {inspectHistoricalWalletFromDatabase} from "./deposit-historical-wallet-db-inspection.js";

const url=process.env.DATABASE_URL;
function disposable(){
 try{const u=new URL(url);return process.env.PROFINO_DISPOSABLE_POSTGRES==="yes" &&
  ["localhost","127.0.0.1","::1"].includes(u.hostname) && u.pathname==="/profino_test";}
 catch{return false;}
}
test("ownership history migration rejects overlap and mutation in isolated PostgreSQL",{skip:!disposable()},async()=>{
 const schema="ownership_"+randomUUID().replaceAll("-","");
 const pool=new pg.Pool({connectionString:url,max:1});
 try{
  await pool.query('CREATE SCHEMA "'+schema+'"');
  await pool.query('CREATE TABLE "'+schema+'".wallets (id bigint PRIMARY KEY, chain_id bigint NOT NULL DEFAULT 56, wallet_address text NOT NULL DEFAULT '+"'0x' || repeat('a',40)"+', is_platform_controlled boolean NOT NULL DEFAULT true)');
  await pool.query('CREATE TABLE "'+schema+'".users (id bigint PRIMARY KEY)');
  await pool.query('INSERT INTO "'+schema+'".wallets VALUES (1),(2)');
  await pool.query('INSERT INTO "'+schema+'".users VALUES (11),(12)');
  const sql=await readFile(new URL("../migrations/20261123_deposit_ownership_history.review.sql",import.meta.url),"utf8");
  // Isolated schema replacement; never run reviewed SQL against public in tests.
  const rehearsal=sql.replaceAll("public.deposit_address_ownership_history",'"'+schema+'".deposit_address_ownership_history')
   .replaceAll("public.reject_deposit_ownership_history_mutation",'"'+schema+'".reject_deposit_ownership_history_mutation')
   .replaceAll("public.wallets",'"'+schema+'".wallets')
   .replaceAll("public.users",'"'+schema+'".users');
  await pool.query(rehearsal);
  const table='"'+schema+'".deposit_address_ownership_history';
  const address="0x"+"a".repeat(40);
  const insert=`INSERT INTO ${table} (wallet_id,user_id,chain_id,wallet_address,start_block,end_block,verified_source)
   VALUES ($1,$2,56,$3,$4,$5,'disposable-review')`;
  await pool.query(insert,[1,11,address,"100","200"]);
  await assert.rejects(pool.query(`INSERT INTO ${table}
   (wallet_id,user_id,chain_id,wallet_address,start_block,end_block,verified_source)
   VALUES (1,11,56,$1,300,400,'')`,[address]),error=>error.code==="23514");
  await assert.rejects(pool.query(insert,[2,12,address,"150","250"]),error=>error.code==="23P01");
  await pool.query(insert,[2,12,address,"200",null]);
  await assert.rejects(pool.query(`UPDATE ${table} SET user_id=12 WHERE wallet_id=1`),/immutable/);
  await assert.rejects(pool.query(`DELETE FROM ${table} WHERE wallet_id=1`),/immutable/);
  // Exercise the read-only inspection query against the isolated schema.
  const owner=await inspectHistoricalWalletFromDatabase(pool,{
   schema,walletAddress:address,eventBlockNumber:"150",expectedUserId:"11"
  });
  assert.deepEqual(owner,{walletId:"1",userId:"11"});
  await assert.rejects(inspectHistoricalWalletFromDatabase(pool,{
   schema,walletAddress:address,eventBlockNumber:"250",expectedUserId:"11"
  }));
  const count=await pool.query(`SELECT count(*)::int AS count FROM ${table}`);
  assert.equal(count.rows[0].count,2);
 }finally{
  await pool.query('DROP SCHEMA IF EXISTS "'+schema+'" CASCADE');
  await pool.end();
 }
});
