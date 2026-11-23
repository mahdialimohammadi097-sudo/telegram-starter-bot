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
  'wallets.is_platform_controlled','deposit_address_ownership_history.wallet_id',
  'deposit_address_ownership_history.user_id','deposit_address_ownership_history.chain_id',
  'deposit_address_ownership_history.wallet_address','deposit_address_ownership_history.start_block',
  'deposit_address_ownership_history.end_block'];
 const missing=required.filter(x=>!names.has(x));
 const tables=['wallets','user_wallet_assignments','deposit_address_ownership_history'];
 const presentTables=[...new Set(columns.rows.map(r=>r.table_name))];
 const missingTables=tables.filter(t=>!presentTables.includes(t));
 const identityConstraints=constraints.rows.filter(r=>r.table_name==='deposit_address_ownership_history');
 const missingConstraintTypes=['p','f','x'].filter(t=>!identityConstraints.some(r=>r.type===t && r.validated===true));
 const structuralReady=missing.length===0 && missingTables.length===0 && missingConstraintTypes.length===0;
 console.log(JSON.stringify({audit:"wallet-ownership-catalog",readyForHistoricalInspection:structuralReady,
  missing,missingTables,missingConstraintTypes,columns:columns.rows,constraints:constraints.rows,
  financialActivationReady:false,realDepositsEnabled:false}));
 await client.query("ROLLBACK");
}catch(error){
 try{await client.query("ROLLBACK")}catch{}
 console.error(JSON.stringify({audit:"wallet-ownership-catalog",readyForHistoricalInspection:false,
  error:"Read-only catalog inspection failed",financialActivationReady:false}));
 process.exitCode=1;
}finally{await client.end().catch(()=>{});}
