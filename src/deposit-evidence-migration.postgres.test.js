import test from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import {readFile} from "node:fs/promises";
const url=process.env.CATALOG_REHEARSAL_URL;
const safeTarget=()=>{
 if(!url || process.env.PROFINO_DISPOSABLE_POSTGRES!=="yes") return false;
 try {
  const target=new URL(url);
  return ["localhost","127.0.0.1","::1"].includes(target.hostname) &&
   target.pathname==="/catalog_rehearsal";
 } catch {return false}
};
test("staged evidence migration creates constrained table and is idempotent",async()=>{
 assert.equal(safeTarget(),true,"Explicit disposable local PostgreSQL target is required");
 const pool=new pg.Pool({connectionString:url});
 const client=await pool.connect();
 const migration=await readFile(new URL("../migrations/20261121_verified_deposit_evidence.sql",import.meta.url),"utf8");
 try{
  await client.query("BEGIN");

  // The migration is explicitly schema-qualified. Test it in a disposable database
  // only, never a production database or an existing shared test schema.
  const check=await client.query("SELECT to_regclass('public.verified_deposit_evidence') AS name");
  assert.equal(check.rows[0].name,null,"CI database must not already contain production evidence table");
  const ddl=migration.replace(/^BEGIN;|^COMMIT;/gm,"");
  await client.query(ddl);
  await client.query(ddl);
  const result=await client.query("SELECT indexdef FROM pg_indexes WHERE schemaname='public' AND tablename='verified_deposit_evidence'");
  assert.ok(result.rows.some(r=>r.indexdef.includes("(event_key)")&&r.indexdef.includes("UNIQUE")));
  await client.query(`INSERT INTO public.verified_deposit_evidence
   (event_key,block_hash,block_number,token_contract,deposit_address,amount_base_units)
   VALUES ('valid','0x' || repeat('a',64),1,'0x' || repeat('b',40),'0x' || repeat('c',40),1000000000000000000)`);
  await client.query("SAVEPOINT invalid_evidence");
  await assert.rejects(client.query(`INSERT INTO public.verified_deposit_evidence
   (event_key,block_hash,block_number,token_contract,deposit_address,amount_base_units)
   VALUES ('bad','0x' || repeat('a',64),1,'0x' || repeat('b',40),'0x' || repeat('c',40),0)`));
  await client.query("ROLLBACK TO SAVEPOINT invalid_evidence");
  const count=await client.query("SELECT count(*)::int AS n FROM public.verified_deposit_evidence");
  assert.equal(count.rows[0].n,1);
 }finally{
  await client.query("ROLLBACK").catch(()=>{});
  client.release();
  await pool.end();
 }
});
