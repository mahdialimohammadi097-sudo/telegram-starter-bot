import { isDisposablePostgresTarget } from "../test-support/disposable-postgres-target.js";
import test from "node:test";
import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";
import pg from "pg";
import {inspectHistoricalWalletSnapshot as inspect} from "./deposit-historical-wallet-db-inspection.js";
const url=process.env.CATALOG_REHEARSAL_URL;
function safeTarget() {
  return isDisposablePostgresTarget(url, "catalog_rehearsal");
}
test("historical wallet snapshot checks real PostgreSQL without write locks or financial authorization",{skip:!safeTarget(),timeout:20000},async()=>{
 const schema="history_snapshot_"+randomUUID().replaceAll("-","");
 const pool=new pg.Pool({connectionString:url,max:1,connectionTimeoutMillis:5000});
 const prefix='"'+schema+'".';
 const address="0x"+"a".repeat(40);
 const input={schema,walletAddress:address,eventBlockNumber:"150",expectedUserId:"11"};
 const insert="INSERT INTO "+prefix+"deposit_address_ownership_history VALUES ($1,$2,56,$3,$4,$5)";
 let created=false;
 try{
  await pool.query('CREATE SCHEMA "'+schema+'"');created=true;
  // Deliberately weak disposable fixture exercises fail-closed inspection, not migration readiness.
  await pool.query("CREATE TABLE "+prefix+"wallets(id bigint PRIMARY KEY,chain_id integer,wallet_address text,is_platform_controlled boolean)");
  await pool.query("CREATE TABLE "+prefix+"deposit_address_ownership_history(wallet_id bigint,user_id bigint,chain_id integer,wallet_address text,start_block numeric(78,0),end_block numeric(78,0))");
  await pool.query("INSERT INTO "+prefix+"wallets VALUES (1,56,$1,true),(2,56,$1,true)",[address]);
  await pool.query(insert,[1,11,address,"100","200"]);
  await pool.query(insert,[2,12,address,"200",null]);
  const consistent={recordConsistent:true,independentHistoricalProof:false,financialActivationReady:false,realDepositsEnabled:false};
  assert.deepEqual(await inspect(pool,input),consistent);
  await assert.rejects(inspect(pool,{...input,eventBlockNumber:"200",expectedUserId:"12"}),/interval mismatch/);
  await pool.query("UPDATE "+prefix+"deposit_address_ownership_history SET end_block=300 WHERE wallet_id=2");
  assert.deepEqual(await inspect(pool,{...input,eventBlockNumber:"200",expectedUserId:"12"}),consistent);
  await assert.rejects(inspect(pool,{...input,eventBlockNumber:"200"}),/identity mismatch/);
  await assert.rejects(inspect(pool,{...input,eventBlockNumber:"99"}),/Missing or ambiguous/);
  // Open-ended overlapping records cannot be ignored, even when a finite record matches.
  await pool.query(insert,[2,12,address,"110",null]);
  await assert.rejects(inspect(pool,input),/Missing or ambiguous/);
  await pool.query("DELETE FROM "+prefix+"deposit_address_ownership_history WHERE end_block IS NULL");
  // Orphan and case-variant records must remain visible and prevent ambiguous attribution.
  await pool.query(insert,[999,12,address.toUpperCase().replace("0X","0x"),"110","180"]);
  await assert.rejects(inspect(pool,input),/Missing or ambiguous/);
  await pool.query("DELETE FROM "+prefix+"deposit_address_ownership_history WHERE wallet_id=999");
  await pool.query("UPDATE "+prefix+"wallets SET is_platform_controlled=false WHERE id=1");
  await assert.rejects(inspect(pool,input),/identity mismatch/);
  assert.equal((await pool.query("SELECT count(*)::int AS count FROM "+prefix+"deposit_address_ownership_history")).rows[0].count,2);
 }finally{try{if(created)await pool.query('DROP SCHEMA "'+schema+'" CASCADE');}finally{await pool.end();}}
});

test("historical inspection rejects RLS-hidden conflicting ownership",{skip:!safeTarget(),timeout:20000},async()=>{
 const suffix=randomUUID().replaceAll("-","");
 const schema="history_rls_"+suffix,role="history_reader_"+suffix;
 const pool=new pg.Pool({connectionString:url,max:1,connectionTimeoutMillis:5000});
 const client=await pool.connect();
 const prefix='"'+schema+'".';
 const address="0x"+"a".repeat(40);
 const input={schema,walletAddress:address,eventBlockNumber:"150",expectedUserId:"11"};
 try {
  await client.query('CREATE ROLE "'+role+'" NOLOGIN NOSUPERUSER NOBYPASSRLS');
  await client.query('CREATE SCHEMA "'+schema+'"');
  await client.query("CREATE TABLE "+prefix+"wallets(id bigint PRIMARY KEY,chain_id integer,wallet_address text,is_platform_controlled boolean)");
  await client.query("CREATE TABLE "+prefix+"deposit_address_ownership_history(wallet_id bigint,user_id bigint,chain_id integer,wallet_address text,start_block numeric(78,0),end_block numeric(78,0))");
  await client.query("INSERT INTO "+prefix+"wallets VALUES (1,56,$1,true),(2,56,$1,true)",[address]);
  await client.query("INSERT INTO "+prefix+"deposit_address_ownership_history VALUES (1,11,56,$1,100,200),(2,12,56,$1,100,200)",[address]);
  await client.query('GRANT USAGE ON SCHEMA "'+schema+'" TO "'+role+'"');
  await client.query('GRANT SELECT ON ALL TABLES IN SCHEMA "'+schema+'" TO "'+role+'"');
  await client.query("ALTER TABLE "+prefix+"deposit_address_ownership_history ENABLE ROW LEVEL SECURITY");
  await client.query("CREATE POLICY visible_history ON "+prefix+'deposit_address_ownership_history FOR SELECT TO "'+role+'" USING (user_id=11)');
  await client.query('SET ROLE "'+role+'"');
  const auditPool={connect:async()=>({query:(...args)=>client.query(...args),release(){}})};
  assert.equal((await client.query("SELECT count(*)::int AS n FROM "+prefix+"deposit_address_ownership_history")).rows[0].n,1);
  await assert.rejects(inspect(auditPool,input),{code:"42501"});
  assert.equal((await client.query("SELECT current_setting('row_security') AS setting")).rows[0].setting,"on");
  assert.equal((await client.query("SELECT 1 AS healthy")).rows[0].healthy,1);
 } finally {
  try {
   await client.query("RESET ROLE");
   await client.query('DROP SCHEMA IF EXISTS "'+schema+'" CASCADE');
   await client.query('DROP ROLE IF EXISTS "'+role+'"');
  } finally {client.release();await pool.end();}
 }
});
