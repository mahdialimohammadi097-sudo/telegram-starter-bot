import { isDisposablePostgresTarget } from "../test-support/disposable-postgres-target.js";
import test from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import {readFile} from "node:fs/promises";
import {persistVerifiedDepositEvidence} from "./verified-deposit-evidence-store.js";
const url=process.env.CATALOG_REHEARSAL_URL;
function safeTarget() {
  return isDisposablePostgresTarget(url, "catalog_rehearsal");
}
test("staged evidence migration creates constrained table and refuses existing relations",async()=>{
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
  // An incompatible preexisting table must not be silently accepted or changed.
  await client.query("SAVEPOINT existing_incompatible");
  await client.query("CREATE TABLE public.verified_deposit_evidence (sentinel text)");
  await client.query("INSERT INTO public.verified_deposit_evidence VALUES ('preserve')");
  await client.query("SAVEPOINT create_conflict");
  await assert.rejects(client.query(ddl), error=>error.code==="42P07");
  await client.query("ROLLBACK TO SAVEPOINT create_conflict");
  assert.deepEqual((await client.query("SELECT sentinel FROM public.verified_deposit_evidence")).rows,[{sentinel:"preserve"}]);
  await client.query("ROLLBACK TO SAVEPOINT existing_incompatible");
  await client.query(ddl);
  // A repeated invocation is a deliberate failure, even for a matching table.
  await client.query("SAVEPOINT repeated_create");
  await assert.rejects(client.query(ddl), error=>error.code==="42P07");
  await client.query("ROLLBACK TO SAVEPOINT repeated_create");
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
  // NaN compares greater than finite numerics in PostgreSQL. A lower bound
  // alone is insufficient. Test both numeric fields and the uint256 ceiling.
  for(const [block,amount] of [
    ["NaN","1"],["1","NaN"],["115792089237316195423570985008687907853269984665640564039457584007913129639936","1"],
    ["1","115792089237316195423570985008687907853269984665640564039457584007913129639936"],["1","-1"],["0.1","1"],["-0.1","1"],["1","1.4"],["1.0","1"],["1","1.0"]
  ]) {
    await client.query("SAVEPOINT invalid_numeric");
    await assert.rejects(client.query(`INSERT INTO public.verified_deposit_evidence
     (event_key,block_hash,block_number,token_contract,deposit_address,amount_base_units)
     VALUES ('bsc:56:0x' || repeat('f',64) || ':5','0x' || repeat('a',64),$1::numeric,
       '0x' || repeat('b',40),'0x' || repeat('c',40),$2::numeric)`,[block,amount]),
      error=>error.code==="23514");
    await client.query("ROLLBACK TO SAVEPOINT invalid_numeric");
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
    assert.equal(columnMap.get(name)?.numeric_precision,null);
    assert.equal(columnMap.get(name)?.numeric_scale,null);
  }
  // Only the reviewed mutation guard may be installed; no posting trigger.
  const triggers=await client.query(`SELECT t.tgname,t.tgenabled,p.proname
    FROM pg_catalog.pg_trigger t JOIN pg_catalog.pg_proc p ON p.oid=t.tgfoid
    WHERE t.tgrelid='public.verified_deposit_evidence'::regclass
      AND NOT t.tgisinternal`);
  assert.deepEqual(triggers.rows,[{tgname:"verified_deposit_evidence_immutable",tgenabled:"A",proname:"reject_verified_deposit_evidence_mutation"}]);
  for(const sql of [
    "UPDATE public.verified_deposit_evidence SET amount_base_units=2",
    "DELETE FROM public.verified_deposit_evidence",
    "TRUNCATE public.verified_deposit_evidence"
  ]){
    await client.query("SAVEPOINT immutable_evidence");
    await assert.rejects(client.query(sql),{code:"55000"});
    await client.query("ROLLBACK TO SAVEPOINT immutable_evidence");
  }
  // Exercise the real store against the reviewed migration, not the legacy fixture.
  await client.query("SET LOCAL search_path = pg_catalog, public");
  const evidence={eventKey:"bsc:56:0x"+"d".repeat(64)+":0",blockHash:"0x"+"a".repeat(64),
   blockNumber:"1",tokenContract:"0x"+"b".repeat(40),depositAddress:"0x"+"c".repeat(40),
   amountBaseUnits:"1000000000000000000"};
  assert.deepEqual(await persistVerifiedDepositEvidence(client,evidence),{inserted:false,eventKey:evidence.eventKey});
  await assert.rejects(persistVerifiedDepositEvidence(client,{...evidence,blockHash:"0x"+"e".repeat(64)}),/Conflicting verified deposit evidence/);
  // The evidence writer needs only INSERT/SELECT; do not require UPDATE
  // permission simply to compare an already committed receipt.
  const writer="evidence_writer_"+(await import("node:crypto")).randomUUID().replaceAll("-","");
  await client.query("SAVEPOINT restricted_writer");
  try{
   await client.query('CREATE ROLE "'+writer+'" NOLOGIN NOSUPERUSER NOBYPASSRLS');
   await client.query('GRANT USAGE ON SCHEMA public TO "'+writer+'"');
   await client.query('GRANT SELECT, INSERT ON public.verified_deposit_evidence TO "'+writer+'"');
   await client.query('SET LOCAL ROLE "'+writer+'"');
   assert.equal((await client.query("SELECT pg_catalog.has_table_privilege(current_user,'public.verified_deposit_evidence','UPDATE') AS allowed")).rows[0].allowed,false);
   assert.deepEqual(await persistVerifiedDepositEvidence(client,evidence),{inserted:false,eventKey:evidence.eventKey});
   const newEvidence={...evidence,eventKey:"bsc:56:0x"+"c".repeat(64)+":9"};
   assert.deepEqual(await persistVerifiedDepositEvidence(client,newEvidence),{inserted:true,eventKey:newEvidence.eventKey});
   await assert.rejects(persistVerifiedDepositEvidence(client,{...newEvidence,amountBaseUnits:"2"}),/Conflicting verified deposit evidence/);
  }finally{
   await client.query("ROLLBACK TO SAVEPOINT restricted_writer");
   await client.query("RELEASE SAVEPOINT restricted_writer");
  }
  // ALWAYS must reject actual mutation attempts in replica mode, including no-op writes.
  for(const sql of [
   "UPDATE public.verified_deposit_evidence SET amount_base_units=2 WHERE false",
   "DELETE FROM public.verified_deposit_evidence WHERE false",
   "TRUNCATE public.verified_deposit_evidence"
  ]){
   await client.query("SAVEPOINT replica_guard");
   try{
    await client.query("SET LOCAL session_replication_role = replica");
    await assert.rejects(client.query(sql),{code:"55000"});
   }finally{await client.query("ROLLBACK TO SAVEPOINT replica_guard");await client.query("RELEASE SAVEPOINT replica_guard");}
  }
  const original=await client.query("SELECT amount_base_units::text AS amount FROM public.verified_deposit_evidence");
  assert.deepEqual(original.rows,[{amount:"1000000000000000000"}]);
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
