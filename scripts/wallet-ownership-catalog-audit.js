// Read-only wallet catalog inspection; prints metadata, never secrets or row data.
// Run only with an explicitly provisioned read-only PostgreSQL connection.
import pg from "pg";
const url=process.env.PROFINO_AUDIT_DATABASE_URL;
if(!url) throw new Error("PROFINO_AUDIT_DATABASE_URL required");
const client=new pg.Client({connectionString:url,connectionTimeoutMillis:5000});
try{
 await client.connect();
 await client.query("BEGIN READ ONLY ISOLATION LEVEL REPEATABLE READ");
 await client.query("SET LOCAL statement_timeout = '10000ms'");
 const columns=await client.query(`
  SELECT table_name,column_name,data_type,is_nullable
  FROM information_schema.columns
  WHERE table_schema='public'
    AND table_name IN ('wallets','user_wallet_assignments','deposit_address_ownership_history')
  ORDER BY table_name,ordinal_position`);
 const constraints=await client.query(`
  SELECT c.relname AS table_name, con.conname AS constraint_name, con.contype AS type,
         con.convalidated AS validated
  FROM pg_constraint con JOIN pg_class c ON c.oid=con.conrelid
  JOIN pg_namespace n ON n.oid=c.relnamespace
  WHERE n.nspname='public'
    AND c.relname IN ('wallets','user_wallet_assignments','deposit_address_ownership_history')
  ORDER BY c.relname,con.conname`);
 const names=new Set(columns.rows.map(r=>r.table_name+"."+r.column_name));
 const required=['wallets.id','wallets.chain_id','wallets.wallet_address',
  'wallets.is_platform_controlled','wallets.status',
  'user_wallet_assignments.id','user_wallet_assignments.user_id',
  'user_wallet_assignments.wallet_id','user_wallet_assignments.assignment_type',
  'user_wallet_assignments.status','user_wallet_assignments.ended_at',
  'deposit_address_ownership_history.wallet_id',
  'deposit_address_ownership_history.user_id','deposit_address_ownership_history.chain_id',
  'deposit_address_ownership_history.wallet_address','deposit_address_ownership_history.start_block',
  'deposit_address_ownership_history.end_block'];
 const missing=required.filter(x=>!names.has(x));
 // Historical ownership requires exact integer block boundaries and typed identities.
 const byName=new Map(columns.rows.map(r=>[r.table_name+"."+r.column_name,r]));
 const requiredTypes=[
  ["deposit_address_ownership_history.wallet_id","bigint"],
  ["deposit_address_ownership_history.user_id","bigint"],
  ["deposit_address_ownership_history.chain_id","bigint"],
  ["deposit_address_ownership_history.start_block","numeric"],
  ["deposit_address_ownership_history.end_block","numeric"],
  ["user_wallet_assignments.user_id","bigint"],
  ["user_wallet_assignments.wallet_id","bigint"],
  ["wallets.id","bigint"],["wallets.chain_id","bigint"],
  ["wallets.is_platform_controlled","boolean"]
 ];
 const typeMismatches=requiredTypes.filter(([name,type])=>
  byName.has(name) && byName.get(name).data_type!==type).map(([name])=>name);
 const nullabilityMismatches=[
  "deposit_address_ownership_history.wallet_id",
  "deposit_address_ownership_history.user_id",
  "deposit_address_ownership_history.chain_id",
  "deposit_address_ownership_history.wallet_address",
  "deposit_address_ownership_history.start_block",
  "user_wallet_assignments.user_id",
  "user_wallet_assignments.wallet_id"
 ].filter(name=>byName.has(name) && byName.get(name).is_nullable!=="NO");
 const tables=['wallets','user_wallet_assignments','deposit_address_ownership_history'];
 const presentTables=[...new Set(columns.rows.map(r=>r.table_name))];
 const missingTables=tables.filter(t=>!presentTables.includes(t));
 const identityConstraints=constraints.rows.filter(r=>r.table_name==='deposit_address_ownership_history');
 const missingConstraintTypes=['p','f','x'].filter(t=>!identityConstraints.some(r=>r.type===t && r.validated===true));
 // Require the named database constraints from the reviewed migration, not merely
 // any unrelated exclusion/unique constraint on the same table.
 const requiredNamedConstraints=[
  ["deposit_address_ownership_history_pkey","p"],
  ["ownership_wallet_unique_start","u"],
  ["ownership_wallet_interval_no_overlap","x"],
  ["ownership_wallet_chain_unique_start","u"],
  ["ownership_interval_no_overlap","x"]
 ];
 const missingNamedConstraints=requiredNamedConstraints
  .filter(([name,type])=>!identityConstraints.some(r=>r.constraint_name===name && r.type===type && r.validated===true))
  .map(([name])=>name);
 const structuralReady=missing.length===0 && missingTables.length===0 &&
  missingConstraintTypes.length===0 && missingNamedConstraints.length===0 &&
  typeMismatches.length===0 && nullabilityMismatches.length===0;
 console.log(JSON.stringify({audit:"wallet-ownership-catalog",readyForHistoricalInspection:structuralReady,
  missing,missingTables,missingConstraintTypes,missingNamedConstraints,typeMismatches,nullabilityMismatches,
  columns:columns.rows,constraints:constraints.rows,
  financialActivationReady:false,realDepositsEnabled:false}));
 if(!structuralReady) process.exitCode=2;
 await client.query("ROLLBACK");
}catch(error){
 try{await client.query("ROLLBACK")}catch{}
 console.error(JSON.stringify({audit:"wallet-ownership-catalog",readyForHistoricalInspection:false,
  error:"Read-only catalog inspection failed",financialActivationReady:false}));
 process.exitCode=1;
}finally{await client.end().catch(()=>{});}
