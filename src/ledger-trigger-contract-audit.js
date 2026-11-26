import {runReadOnlyDepositAudit} from "./read-only-deposit-audit.js";

// Catalog shape evidence only: enabled triggers and expected event/timing,
// relation and function binding. This does not authenticate function bodies
// or establish that a privileged role cannot disable the guards.
const expected = Object.freeze([
  {table:"ledger_transactions",name:"ledger_transactions_balance_check",fn:"check_ledger_balance",type:21,deferred:true},
  {table:"ledger_entries",name:"ledger_entries_balance_check",fn:"check_ledger_balance",type:29,deferred:true},
  {table:"ledger_transactions",name:"protect_posted_transactions",fn:"protect_posted_transaction",type:27,deferred:false},
  {table:"ledger_entries",name:"protect_posted_ledger_entries",fn:"protect_posted_entries",type:31,deferred:false}
]);

export async function auditLedgerTriggerContract(pool,{schema="public"}={}) {
  if(typeof schema!=="string"||!/^[a-z_][a-z0-9_]{0,62}$/.test(schema)) throw new Error("Invalid ledger schema");
  return runReadOnlyDepositAudit(pool,client=>inspectLedgerTriggerContract(client,{schema}));
}

// Internal inspection; caller must hold a verified read-only snapshot.
export async function inspectLedgerTriggerContract(client,{schema="public"}={}) {
  if(typeof schema!=="string"||!/^[a-z_][a-z0-9_]{0,62}$/.test(schema)) throw new Error("Invalid ledger schema");
    const {rows}=await client.query(`
      SELECT c.relname AS table_name,t.tgname AS trigger_name,t.tgenabled,
             t.tgtype::int AS trigger_type,t.tgdeferrable,t.tginitdeferred,
             t.tgqual IS NULL AS unconditional,t.tgnargs=0 AS no_args,
             t.tgconstraint<>0 AS constraint_trigger,
             p.proname AS function_name,fn.nspname AS function_schema,
             p.pronargs::int AS function_args,p.prorettype='pg_catalog.trigger'::regtype AS trigger_result,
             p.prosecdef,p.prokind,l.lanname
      FROM pg_catalog.pg_trigger t
      JOIN pg_catalog.pg_class c ON c.oid=t.tgrelid
      JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
      JOIN pg_catalog.pg_proc p ON p.oid=t.tgfoid
      JOIN pg_catalog.pg_namespace fn ON fn.oid=p.pronamespace
      JOIN pg_catalog.pg_language l ON l.oid=p.prolang
      WHERE n.nspname=$1 AND c.relkind='r' AND NOT t.tgisinternal
        AND c.relname IN ('ledger_accounts','ledger_transactions','ledger_entries')
    `,[schema]);
    if(!Array.isArray(rows)) throw new Error("Incomplete ledger trigger evidence");
    const checks=expected.map(e=>{
      const matches=rows.filter(r=>r.table_name===e.table&&r.trigger_name===e.name);
      const x=matches[0];
      const compatible=matches.length===1&&["O","A"].includes(x.tgenabled)&&
        x.trigger_type===e.type&&x.tgdeferrable===e.deferred&&x.tginitdeferred===e.deferred&&
        x.constraint_trigger===e.deferred&&x.unconditional===true&&x.no_args===true&&
        x.function_name===e.fn&&x.function_schema===schema&&x.function_args===0&&
        x.trigger_result===true&&x.prosecdef===false&&x.prokind==="f"&&x.lanname==="plpgsql";
      return {name:e.name,present:matches.length===1,compatible};
    });
    // Any additional non-internal trigger, even disabled, needs independent review.
    // Report only a count, never arbitrary database object names or function text.
    const unexpectedTriggerCount=rows.filter(r=>!expected.some(e=>e.table===r.table_name&&e.name===r.trigger_name)).length;
    return {scope:"ledger-trigger-catalog-shape-only",checks,unexpectedTriggerCount,
      compatible:unexpectedTriggerCount===0&&checks.every(c=>c.compatible),
      functionBodiesVerified:false,productionReady:false};
}
