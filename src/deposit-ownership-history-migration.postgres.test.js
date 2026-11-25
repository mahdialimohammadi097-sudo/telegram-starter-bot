import test from "node:test";
import {inspectHistoricalGuardInventory} from "./admin-schema-audit.js";
import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";
import {readFile} from "node:fs/promises";
import pg from "pg";
import {inspectHistoricalWalletSnapshot as inspect} from "./deposit-historical-wallet-db-inspection.js";
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
 const pool=new pg.Pool({connectionString:url,max:2,connectionTimeoutMillis:5000});
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
  // Non-durable source tables and inherited rows are not a reviewed ownership source.
  await client.query("ALTER TABLE "+prefix+"wallets SET UNLOGGED");
  await assert.rejects(client.query(rehearsal),/source column prerequisites not confirmed/);
  await client.query("ROLLBACK");
  assert.equal((await client.query("SELECT pg_catalog.to_regclass($1) AS relation",[table])).rows[0].relation,null);
  await client.query("ALTER TABLE "+prefix+"wallets SET LOGGED");
  await client.query("CREATE TABLE "+prefix+"wallet_children () INHERITS ("+prefix+"wallets)");
  await assert.rejects(client.query(rehearsal),/source column prerequisites not confirmed/);
  await client.query("ROLLBACK");
  assert.equal((await client.query("SELECT pg_catalog.to_regclass($1) AS relation",[table])).rows[0].relation,null);
  await client.query("DROP TABLE "+prefix+"wallet_children");
  // Simulate unsafe schema-scoped default ACLs without changing global defaults.
  for(const kind of ["TABLES","SEQUENCES","FUNCTIONS"]){
   await client.query('ALTER DEFAULT PRIVILEGES IN SCHEMA "'+schema+'" GRANT ALL ON '+kind+' TO PUBLIC');
  }
  await client.query(rehearsal);
  const publicGrants=await client.query(`
   SELECT count(*)::int AS n FROM (
    SELECT acl.grantee FROM pg_catalog.pg_class c
     JOIN pg_catalog.pg_namespace ns ON ns.oid=c.relnamespace
     CROSS JOIN LATERAL pg_catalog.aclexplode(COALESCE(c.relacl,
       pg_catalog.acldefault(CASE WHEN c.relkind='S' THEN 'S' ELSE 'r' END::"char",c.relowner))) acl
     WHERE ns.nspname=$1 AND c.relname IN ('deposit_address_ownership_history','deposit_address_ownership_history_id_seq')
    UNION ALL
    SELECT acl.grantee FROM pg_catalog.pg_proc p
     JOIN pg_catalog.pg_namespace ns ON ns.oid=p.pronamespace
     CROSS JOIN LATERAL pg_catalog.aclexplode(COALESCE(p.proacl,pg_catalog.acldefault('f',p.proowner))) acl
     WHERE ns.nspname=$1 AND p.proname IN ('validate_deposit_ownership_wallet_identity','reject_deposit_ownership_history_mutation')
   ) grants WHERE grantee=0`,[schema]);
  assert.equal(publicGrants.rows[0].n,0);
  // Both reviewed migration candidates must coexist in the same isolated schema.
  const evidenceDdl=await readFile(new URL("../migrations/20261121_verified_deposit_evidence.sql",import.meta.url),"utf8");
  await client.query(evidenceDdl.replaceAll("public.",prefix));
  const evidenceTable=prefix+"verified_deposit_evidence";
  const eventKey="bsc:56:0x"+"c".repeat(64)+":0";
  const receiptSql="INSERT INTO "+evidenceTable+"(event_key,block_hash,block_number,token_contract,deposit_address,amount_base_units) VALUES ($1,$2,199,$3,$4,1000000000000000000)";
  await client.query(receiptSql,[eventKey,"0x"+"d".repeat(64),other,address]);
  await assert.rejects(client.query(receiptSql,[eventKey,"0x"+"d".repeat(64),other,address]),{code:"23505"});
  await assert.rejects(client.query("UPDATE "+evidenceTable+" SET block_number=200"),{code:"55000"});
  // Basic catalog readiness must detect missing/disabled guards, even if all columns exist.
  assert.equal(await inspectHistoricalGuardInventory(client,schema),true);
  await client.query("ALTER TABLE "+table+" DISABLE TRIGGER deposit_ownership_history_immutable");
  assert.equal(await inspectHistoricalGuardInventory(client,schema),false);
  await client.query("ALTER TABLE "+table+" ENABLE ALWAYS TRIGGER deposit_ownership_history_immutable");
  await client.query("BEGIN");
  try {
   await client.query("ALTER TABLE "+table+" DROP CONSTRAINT ownership_interval_no_overlap");
   assert.equal(await inspectHistoricalGuardInventory(client,schema),false);
  } finally { await client.query("ROLLBACK"); }
  assert.equal(await inspectHistoricalGuardInventory(client,schema),true);
  const insert=(wallet,user,addr,start,end)=>client.query(
   "INSERT INTO "+table+"(wallet_id,user_id,chain_id,wallet_address,start_block,end_block,verified_source) VALUES ($1,$2,56,$3,$4,$5,'disposable-review')",
   [wallet,user,addr,start,end]);
  await insert(1,11,address,"100","200");
  await assert.rejects(insert(2,12,address,"150","250"),{code:"23P01"});
  await assert.rejects(insert(1,12,address,"150","180"),{code:"23P01"});
  await insert(2,12,address,"200","300");
  await insert(2,12,address,"300","400");
  // Exercise the real read-only inspector against the actual reviewed DDL,
  // using a separately checked-out connection, not a hand-built mock table.
  const input={schema,walletAddress:address,eventBlockNumber:"199",expectedUserId:"11"};
  const expected={recordConsistent:true,independentHistoricalProof:false,financialActivationReady:false,realDepositsEnabled:false};
  assert.deepEqual(await inspect(pool,input),expected);
  // The stored receipt and historical owner remain consistent across both schemas;
  // this does not establish independent chain provenance or authorize posting.
  const stored=await client.query("SELECT deposit_address,block_number::text AS block_number FROM "+evidenceTable+" WHERE event_key=$1",[eventKey]);
  assert.deepEqual(stored.rows,[{deposit_address:address,block_number:"199"}]);
  assert.deepEqual(await inspect(pool,{...input,walletAddress:stored.rows[0].deposit_address,eventBlockNumber:stored.rows[0].block_number}),expected);
  assert.deepEqual(await inspect(pool,{...input,eventBlockNumber:"200",expectedUserId:"12"}),expected);
  await assert.rejects(inspect(pool,{...input,eventBlockNumber:"200"}),/identity mismatch/);
  await assert.rejects(inspect(pool,{...input,eventBlockNumber:"400"}),/Missing or ambiguous/);
  await assert.rejects(inspect(pool,{...input,eventBlockNumber:"99"}),/Missing or ambiguous/);
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
  // Execute ALWAYS triggers in replica mode, rather than only inspecting catalog flags.
  // The disposable CI database uses a privileged test account. This does not
  // establish production privileges or resistance to privileged trigger disabling.
  for(const [statement,expectedError] of [
   ["UPDATE "+table+" SET user_id=12 WHERE wallet_id=1",/immutable/],
   ["DELETE FROM "+table+" WHERE wallet_id=1",/immutable/],
   ["TRUNCATE "+table,/immutable/],
   ["INSERT INTO "+table+"(wallet_id,user_id,chain_id,wallet_address,start_block,end_block,verified_source) VALUES (3,11,56,'"+address+"',500,600,'disposable-review')",/identity mismatch/]
  ]){
   await client.query("BEGIN");
   try{
    await client.query("SET LOCAL session_replication_role = replica");
    await assert.rejects(client.query(statement),expectedError);
   }finally{await client.query("ROLLBACK");}
  }
  await assert.rejects(client.query(rehearsal),{code:"42P07"});
  await client.query("ROLLBACK");
  assert.equal((await client.query("SELECT count(*)::int AS n FROM "+table)).rows[0].n,4);
  // Competing autocommit writers must not both claim overlapping ownership,
  // even when their wallet IDs and interval starts are different.
  const competingSql="INSERT INTO "+table+"(wallet_id,user_id,chain_id,wallet_address,start_block,end_block,verified_source) VALUES ($1,$2,56,$3,$4,$5,'disposable-review')";
  const claims=[[1,11,address,"500","600"],[2,12,address,"550","650"]];
  const results=await Promise.allSettled([
   client.query(competingSql,claims[0]),
   pool.query(competingSql,claims[1])
  ]);
  assert.equal(results.filter(r=>r.status==="fulfilled").length,1);
  const loser=results.findIndex(r=>r.status==="rejected");
  assert.ok(["23P01","40P01"].includes(results[loser].reason.code));
  // A retry after any deadlock must still reject the already committed conflict.
  await assert.rejects(client.query(competingSql,claims[loser]),{code:"23P01"});
  assert.equal((await client.query("SELECT count(*)::int AS n FROM "+table)).rows[0].n,5);
  // Missing users and non-platform wallets must not create ownership records.
  await assert.rejects(insert(1,999,address,"700","710"),{code:"23503"});
  // Internal FK triggers are not ALWAYS triggers. The explicit user check
  // must reject a missing user even in replica mode.
  await client.query("BEGIN");
  try{
   await client.query("SET LOCAL session_replication_role = replica");
   await assert.rejects(insert(1,999,address,"700","710"),{code:"23503"});
  }finally{await client.query("ROLLBACK");}
  await client.query("INSERT INTO "+prefix+"wallets VALUES (4,56,$1,false)",[other]);
  await assert.rejects(insert(4,11,other,"700","710"),/identity mismatch/);
  // A conflicting second row must roll back an otherwise valid first row.
  const batchSql="INSERT INTO "+table+"(wallet_id,user_id,chain_id,wallet_address,start_block,end_block,verified_source) VALUES (1,11,56,$1,700,710,'disposable-review'),(2,12,56,$1,710,720,'disposable-review'),(1,11,56,$1,705,715,'disposable-review')";
  await assert.rejects(client.query(batchSql,[address]),{code:"23P01"});
  assert.equal((await client.query("SELECT count(*)::int AS n FROM "+table+" WHERE start_block >= 700 AND start_block < 720")).rows[0].n,0);
  assert.equal((await client.query("SELECT count(*)::int AS n FROM "+table)).rows[0].n,5);
 }finally{
  try{
   await client.query("ROLLBACK");
   await client.query('DROP SCHEMA IF EXISTS "'+schema+'" CASCADE');
  }finally{client.release();await pool.end();}
 }
});
