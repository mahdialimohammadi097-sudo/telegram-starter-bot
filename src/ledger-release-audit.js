// Operator-only evidence from one bounded read-only snapshot.
// This does not authorize production financial activity.
import {inspectLedgerIntegrity} from "./ledger-integrity-audit.js";
import {inspectLedgerTriggerContract} from "./ledger-trigger-contract-audit.js";
import {inspectReviewedLedgerBodies} from "./ledger-reviewed-bodies.js";
import {runReadOnlyDepositAudit} from "./read-only-deposit-audit.js";

export async function collectLedgerReleaseEvidence(pool,{schema="public"}={}) {
  if(typeof schema!=="string"||!/^[a-z_][a-z0-9_]{0,62}$/.test(schema)) throw new Error("Invalid ledger schema");
  return runReadOnlyDepositAudit(pool,async client=>{
    const {rows}=await client.query(`
      SELECT c.relname,c.relkind,c.relpersistence,
        EXISTS (SELECT 1 FROM pg_catalog.pg_inherits i
          WHERE i.inhrelid=c.oid OR i.inhparent=c.oid) AS inheritance_link,
        EXISTS (SELECT 1 FROM pg_catalog.pg_rewrite rw
          WHERE rw.ev_class=c.oid) AS rewrite_rule
      FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname=$1 AND c.relname IN ('ledger_accounts','ledger_transactions','ledger_entries')
    `,[schema]);
    if(rows?.length!==3||new Set(rows.map(r=>r.relname)).size!==3||
      rows.some(r=>r.relkind!=="r"||r.relpersistence!=="p")){
      throw new Error("Ledger evidence requires three permanent ordinary tables");
    }
    // Inheritance can expand a normal SELECT beyond the reviewed tables.
    // Rewrite rules can alter the meaning of future writes without a trigger.
    // Fail closed on either; do not return object names or rule definitions.
    if(rows.some(r=>typeof r.inheritance_link!=="boolean"||typeof r.rewrite_rule!=="boolean")){
      throw new Error("Incomplete ledger relation evidence");
    }
    const relations={
      inheritanceFree:rows.every(r=>r.inheritance_link===false),
      rewriteRuleFree:rows.every(r=>r.rewrite_rule===false)
    };
    if(!relations.inheritanceFree||!relations.rewriteRuleFree){
      throw new Error("Ledger relations contain unreviewed inheritance or rewrite rules");
    }
    // A clean current snapshot is insufficient if duplicate identities are
    // not constrained by the database. Inspect immediate, valid, nonpartial
    // constraint-backed unique indexes, not merely their names.
    const identityRows=(await client.query(`
      SELECT c.relname AS table_name,k.contype,
        ARRAY(SELECT a.attname::text
          FROM pg_catalog.unnest(k.conkey) WITH ORDINALITY AS key(attnum,pos)
          JOIN pg_catalog.pg_attribute a ON a.attrelid=c.oid AND a.attnum=key.attnum
          ORDER BY key.pos) AS columns,
        k.convalidated AND NOT k.condeferrable AND NOT k.condeferred
          AND i.indisunique AND i.indisvalid AND i.indisready AND i.indislive
          AND i.indimmediate AND i.indpred IS NULL AND i.indexprs IS NULL
          AND i.indrelid=c.oid AND i.indnkeyatts=pg_catalog.cardinality(k.conkey)
          AND (k.contype<>'p' OR i.indisprimary) AS compatible
      FROM pg_catalog.pg_constraint k
      JOIN pg_catalog.pg_class c ON c.oid=k.conrelid
      JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
      JOIN pg_catalog.pg_index i ON i.indexrelid=k.conindid
      WHERE n.nspname=$1 AND c.relname IN ('ledger_accounts','ledger_transactions','ledger_entries')
        AND k.contype IN ('p','u')
    `,[schema])).rows;
    if(!Array.isArray(identityRows))throw new Error("Incomplete ledger identity evidence");
    const expected=[
      ["ledger_accounts","p",["id"]],
      ["ledger_transactions","p",["id"]],
      ["ledger_entries","p",["id"]],
      ["ledger_accounts","u",["account_code"]],
      ["ledger_accounts","u",["user_id","account_type","currency"]],
      ["ledger_transactions","u",["idempotency_key"]]
    ];
    const identities=expected.map(([table,type,columns])=>({
      table,type,columns,
      compatible:identityRows.some(row=>row.table_name===table&&row.contype===type&&
        row.compatible===true&&Array.isArray(row.columns)&&
        row.columns.length===columns.length&&columns.every((name,index)=>row.columns[index]===name))
    }));
    const identityConstraints={checks:identities,compatible:identities.every(x=>x.compatible)};
    const integrity=await inspectLedgerIntegrity(client,{schema});
    const triggers=await inspectLedgerTriggerContract(client,{schema});
    const reviewedBodies=await inspectReviewedLedgerBodies(client,{schema});
    return {
      audit:"ledger-release-evidence",scope:"internal-ledger-and-trigger-shape-only",
      sameSnapshot:true,
      relations,identityConstraints,integrity,triggers,reviewedBodies,
      checksPassed:identityConstraints.compatible===true&&integrity.clean===true&&triggers.compatible===true&&reviewedBodies.match===true,
      custodyVerified:false,financialActivationReady:false,productionReady:false
    };
  });
}
