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
         con.convalidated AS validated, pg_get_constraintdef(con.oid) AS definition
  FROM pg_constraint con JOIN pg_class c ON c.oid=con.conrelid
  JOIN pg_namespace n ON n.oid=c.relnamespace
  WHERE n.nspname='public'
    AND c.relname IN ('wallets','user_wallet_assignments','deposit_address_ownership_history')
  ORDER BY c.relname,con.conname`);
 const triggers=await client.query(`
  SELECT tg.tgname AS trigger_name, tg.tgenabled AS enabled,
         tg.tgtype AS trigger_type,
         p.proname AS function_name, pn.nspname AS function_schema,
         pg_get_functiondef(p.oid) AS function_definition
  FROM pg_trigger tg
  JOIN pg_class rel ON rel.oid=tg.tgrelid
  JOIN pg_namespace ns ON ns.oid=rel.relnamespace
  JOIN pg_proc p ON p.oid=tg.tgfoid
  JOIN pg_namespace pn ON pn.oid=p.pronamespace
  WHERE ns.nspname='public'
    AND rel.relname='deposit_address_ownership_history'
    AND NOT tg.tgisinternal
  ORDER BY tg.tgname`);
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
 // PostgreSQL tgtype bits: ROW=1, BEFORE=2, INSERT=4, DELETE=8, UPDATE=16.
 // A matching name/function alone is not enough if the trigger fires on the wrong event.
 // Names alone do not establish that exclusion constraints cover wallet/address
 // and overlapping block ranges. Inspect their actual PostgreSQL definitions.
 const requiredConstraintFragments=[
  ["ownership_wallet_interval_no_overlap",["EXCLUDE USING gist","wallet_id WITH =","&&"]],
  ["ownership_interval_no_overlap",["EXCLUDE USING gist","chain_id WITH =","wallet_address WITH =","&&"]],
  ["ownership_wallet_unique_start",["UNIQUE","wallet_id","start_block"]],
  ["ownership_wallet_chain_unique_start",["UNIQUE","chain_id","wallet_address","start_block"]]
 ];
 const mismatchedConstraintDefinitions=requiredConstraintFragments
  .filter(([name,fragments])=>{
   const found=identityConstraints.find(r=>r.constraint_name===name);
   return found && !fragments.every(fragment=>found.definition.includes(fragment));
  }).map(([name])=>name);
 // A same-named CHECK constraint may be weakened without changing its name.
 // Require the essential chain, address, interval and source checks by definition.
 const requiredCheckFragments=[
  ["deposit_address_ownership_history_chain_id_check",["chain_id","56"]],
  ["deposit_address_ownership_history_wallet_address_check",["wallet_address","0x"]],
  ["deposit_address_ownership_history_start_block_check",["start_block",">= 0"]],
  ["deposit_address_ownership_history_end_block_check",["end_block","start_block"]],
  ["deposit_address_ownership_history_verified_source_check",["verified_source","length","8"]]
 ];
 const missingOrWeakChecks=requiredCheckFragments.filter(([name,fragments])=>{
  const found=identityConstraints.find(r=>r.constraint_name===name && r.type==="c" && r.validated===true);
  return !found || !fragments.every(fragment=>found.definition.includes(fragment));
 }).map(([name])=>name);
 const requiredTriggers=[
  ["deposit_ownership_wallet_identity","validate_deposit_ownership_wallet_identity",7],
  ["deposit_ownership_history_immutable","reject_deposit_ownership_history_mutation",27]
 ];
 const missingTriggers=requiredTriggers.filter(([name,fn,type])=>
  !triggers.rows.some(r=>r.trigger_name===name && r.function_name===fn &&
   r.enabled==="O" && r.function_schema==="public" && Number(r.trigger_type)===type))
  .map(([name])=>name);
 // Reject trigger functions whose critical identity/immutability logic was replaced.
 const requiredFunctionFragments=[
  ["deposit_ownership_wallet_identity",["FOR SHARE","wallet_address","chain_id","is_platform_controlled","RAISE EXCEPTION"]],
  ["deposit_ownership_history_immutable",["RAISE EXCEPTION"]]
 ];
 const weakTriggerFunctions=requiredFunctionFragments.filter(([name,fragments])=>{
  const found=triggers.rows.find(r=>r.trigger_name===name);
  return !found || !fragments.every(fragment=>found.function_definition.includes(fragment));
 }).map(([name])=>name);
 const structuralReady=missing.length===0 && missingTables.length===0 &&
  missingConstraintTypes.length===0 && missingNamedConstraints.length===0 &&
  typeMismatches.length===0 && nullabilityMismatches.length===0 && missingTriggers.length===0 &&
  mismatchedConstraintDefinitions.length===0 && missingOrWeakChecks.length===0 &&
  weakTriggerFunctions.length===0;
 console.log(JSON.stringify({audit:"wallet-ownership-catalog",readyForHistoricalInspection:structuralReady,
  missing,missingTables,missingConstraintTypes,missingNamedConstraints,typeMismatches,nullabilityMismatches,
  missingTriggers,mismatchedConstraintDefinitions,missingOrWeakChecks,weakTriggerFunctions,
  columns:columns.rows,
  constraints:constraints.rows,triggers:triggers.rows,
  financialActivationReady:false,realDepositsEnabled:false}));
 if(!structuralReady) process.exitCode=2;
 await client.query("ROLLBACK");
}catch(error){
 try{await client.query("ROLLBACK")}catch{}
 console.error(JSON.stringify({audit:"wallet-ownership-catalog",readyForHistoricalInspection:false,
  error:"Read-only catalog inspection failed",financialActivationReady:false}));
 process.exitCode=1;
}finally{await client.end().catch(()=>{});}
