import { isDisposablePostgresTarget } from "../test-support/disposable-postgres-target.js";
import test from "node:test";
import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";
import {readFileSync} from "node:fs";
import pg from "pg";

const url=process.env.CATALOG_REHEARSAL_URL;
test("manual deposit catalogs inspect historical ownership on PostgreSQL despite caller catalog shadowing",{
 skip:!isDisposablePostgresTarget(url,"catalog_rehearsal"),timeout:20000
},async()=>{
 const name="profino_test_"+randomUUID().replaceAll("-","");
 const admin=new pg.Client({connectionString:url,connectionTimeoutMillis:5000});
 let created=false,client;
 await admin.connect();
 try{
  await admin.query('CREATE DATABASE "'+name+'"');created=true;
  const target=new URL(url);target.pathname="/"+name;
  client=new pg.Client({connectionString:target.toString(),connectionTimeoutMillis:5000});
  await client.connect();
  // Synthetic metadata only, not a production migration or an actual wallet.
  await client.query(`CREATE TABLE public.verified_deposit_evidence(event_key text PRIMARY KEY);
   CREATE TABLE public.deposit_address_ownership_history(id bigint PRIMARY KEY);
   CREATE FUNCTION public.fixture_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END; $$;
   CREATE TRIGGER fixture_guard BEFORE INSERT ON public.deposit_address_ownership_history FOR EACH ROW EXECUTE FUNCTION public.fixture_guard();
   CREATE SCHEMA catalog_shadow;
   CREATE TABLE catalog_shadow.deposit_address_ownership_history(shadow_only int);
   CREATE TEMP TABLE pg_class(shadow_only int);
   CREATE TEMP TABLE pg_namespace(shadow_only int);
   CREATE TEMP TABLE pg_index(shadow_only int);
   CREATE TEMP TABLE pg_constraint(shadow_only int);
   CREATE TEMP TABLE pg_trigger(shadow_only int);
   CREATE TEMP TABLE pg_indexes(shadow_only int)`);
  const files=["deposit-wallet-catalog.sql","read-only-deposit-catalog.sql"];
  const baseline=[];
  for(const file of files){
   const sql=readFileSync(new URL("../scripts/"+file,import.meta.url),"utf8");
   const result=await client.query(sql);
   assert.ok(Array.isArray(result));
   const selects=result.filter(r=>r.command==="SELECT").map(r=>r.rows);
   assert.equal(selects.length,file===files[0]?5:4);
   const inventories=file===files[0]?selects.slice(1):selects.slice(0,3);
   for(const rows of inventories.slice(0,3)){
    assert.deepEqual([...new Set(rows.map(r=>r.table_name??r.tablename))].sort(),["deposit_address_ownership_history","verified_deposit_evidence"]);
   }
   assert.ok(inventories[0].some(r=>r.table_name==="deposit_address_ownership_history"&&r.column_name==="id"));
   assert.ok(!inventories[0].some(r=>r.column_name==="shadow_only"));
   if(file===files[0]){
    assert.ok(inventories[3].some(r=>r.table_name==="deposit_address_ownership_history"&&r.tgname==="fixture_guard"));
   }else{
    assert.equal(selects[3][0].read_only,"on");
    assert.equal(selects[3][0].isolation,"repeatable read");
   }
   baseline.push(selects);
  }
  await client.query("SET search_path = catalog_shadow, pg_temp, pg_catalog, public");
  const original=(await client.query("SHOW search_path")).rows[0].search_path;
  for(const [i,file] of files.entries()){
   const result=await client.query(readFileSync(new URL("../scripts/"+file,import.meta.url),"utf8"));
   assert.deepEqual(result.filter(r=>r.command==="SELECT").map(r=>r.rows),baseline[i],file);
   assert.equal((await client.query("SHOW search_path")).rows[0].search_path,original);
   assert.equal(client.getTransactionStatus(),"I");
  }
 }finally{
  try{if(client)await client.end();}
  finally{try{if(created)await admin.query('DROP DATABASE "'+name+'"');}finally{await admin.end();}}
 }
});
