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
   VALUES ('bsc:56:0x' || repeat('d',64) || ':0','0x' || repeat('a',64),1,'0x' || repeat('b',40),'0x' || repeat('c',40),1000000000000000000)`);
  await client.query("SAVEPOINT invalid_evidence");
  await assert.rejects(client.query(`INSERT INTO public.verified_deposit_evidence
   (event_key,block_hash,block_number,token_contract,deposit_address,amount_base_units)
   VALUES ('bad','0x' || repeat('a',64),1,'0x' || repeat('b',40),'0x' || repeat('c',40),0)`));
  await client.query("ROLLBACK TO SAVEPOINT invalid_evidence");
  // A duplicate chain event must never create a second evidence record.
  await client.query("SAVEPOINT duplicate_event");
  await assert.rejects(
   client.query(`INSERT INTO public.verified_deposit_evidence
    (event_key,block_hash,block_number,token_contract,deposit_address,amount_base_units)
    VALUES ('bsc:56:0x' || repeat('d',64) || ':0','0x' || repeat('a',64),1,
            '0x' || repeat('b',40),'0x' || repeat('c',40),1000000000000000000)`),
   error=>error.code==="23505"
  );
  await client.query("ROLLBACK TO SAVEPOINT duplicate_event");
  // A positive amount with an invalid chain event key is also forbidden.
  await client.query("SAVEPOINT invalid_event_key");
  await assert.rejects(
   client.query(`INSERT INTO public.verified_deposit_evidence
    (event_key,block_hash,block_number,token_contract,deposit_address,amount_base_units)
    VALUES ('not-a-chain-event','0x' || repeat('a',64),1,
            '0x' || repeat('b',40),'0x' || repeat('c',40),1)`),
   error=>error.code==="23514"
  );
  await client.query("ROLLBACK TO SAVEPOINT invalid_event_key");
  // Reject malformed addresses and negative block numbers independently.
  for (const [label, values] of [
    ["invalid_address", ["'bsc:56:0x' || repeat('e',64) || ':1'","'0x' || repeat('a',64)","1","'0x' || repeat('b',40)","'not-an-address'","1"]],
    ["negative_block", ["'bsc:56:0x' || repeat('e',64) || ':2'","'0x' || repeat('a',64)","-1","'0x' || repeat('b',40)","'0x' || repeat('c',40)","1"]]
  ]) {
    await client.query("SAVEPOINT " + label);
    await assert.rejects(client.query(`INSERT INTO public.verified_deposit_evidence
      (event_key,block_hash,block_number,token_contract,deposit_address,amount_base_units)
      VALUES (${values.join(",")})`), error=>error.code==="23514");
    await client.query("ROLLBACK TO SAVEPOINT " + label);
  }
  // Invalid token contracts and zero amounts must be rejected by PostgreSQL.
  for (const [label, values] of [
    ["invalid_token", ["'bsc:56:0x' || repeat('e',64) || ':3'","'0x' || repeat('a',64)","1","'bad-token'","'0x' || repeat('c',40)","1"]],
    ["zero_amount", ["'bsc:56:0x' || repeat('e',64) || ':4'","'0x' || repeat('a',64)","1","'0x' || repeat('b',40)","'0x' || repeat('c',40)","0"]]
  ]) {
    await client.query("SAVEPOINT " + label);
    await assert.rejects(client.query(`INSERT INTO public.verified_deposit_evidence
      (event_key,block_hash,block_number,token_contract,deposit_address,amount_base_units)
      VALUES (${values.join(",")})`), error=>error.code==="23514");
    await client.query("ROLLBACK TO SAVEPOINT " + label);
  }
  // The production candidate must not modify ledger or user balances.
  const columns=await client.query(`SELECT column_name,data_type,numeric_precision,numeric_scale,is_nullable
    FROM information_schema.columns
    WHERE table_schema='public' AND table_name='verified_deposit_evidence'`);
  const columnMap=new Map(columns.rows.map(row=>[row.column_name,row]));
  for(const name of ["event_key","block_hash","block_number","token_contract","deposit_address","amount_base_units"]) {
    assert.equal(columnMap.get(name)?.is_nullable,"NO",name+" must be NOT NULL");
  }
  for(const name of ["block_number","amount_base_units"]) {
    assert.equal(columnMap.get(name)?.data_type,"numeric");
    assert.equal(Number(columnMap.get(name)?.numeric_precision),78);
    assert.equal(Number(columnMap.get(name)?.numeric_scale),0);
  }
  // Evidence-only migration must not introduce ledger posting triggers.
  const triggers=await client.query(`SELECT tgname FROM pg_trigger
    WHERE tgrelid='public.verified_deposit_evidence'::regclass
      AND NOT tgisinternal`);
  assert.deepEqual(triggers.rows,[],"Evidence table must not post balances via triggers");
  const ledgerTouches=await client.query(`SELECT count(*)::int AS n FROM pg_depend d
    JOIN pg_class source ON source.oid=d.objid
    WHERE source.oid='public.verified_deposit_evidence'::regclass
      AND d.refobjid IN (
        to_regclass('public.ledger_accounts'),
        to_regclass('public.ledger_entries'),
        to_regclass('public.ledger_transactions')
      )`);
  assert.equal(ledgerTouches.rows[0].n,0,"Evidence table must not depend on ledger tables");
  const count=await client.query("SELECT count(*)::int AS n FROM public.verified_deposit_evidence");
  assert.equal(count.rows[0].n,1);
 }finally{
  await client.query("ROLLBACK").catch(()=>{});
  client.release();
  await pool.end();
 }
});
