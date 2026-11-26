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
      SELECT c.relname,c.relkind,c.relpersistence
      FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname=$1 AND c.relname IN ('ledger_accounts','ledger_transactions','ledger_entries')
    `,[schema]);
    if(rows?.length!==3||new Set(rows.map(r=>r.relname)).size!==3||
      rows.some(r=>r.relkind!=="r"||r.relpersistence!=="p")){
      throw new Error("Ledger evidence requires three permanent ordinary tables");
    }
    const integrity=await inspectLedgerIntegrity(client,{schema});
    const triggers=await inspectLedgerTriggerContract(client,{schema});
    const reviewedBodies=await inspectReviewedLedgerBodies(client,{schema});
    return {
      audit:"ledger-release-evidence",scope:"internal-ledger-and-trigger-shape-only",
      sameSnapshot:true,
      integrity,triggers,reviewedBodies,
      checksPassed:integrity.clean===true&&triggers.compatible===true&&reviewedBodies.match===true,
      custodyVerified:false,financialActivationReady:false,productionReady:false
    };
  });
}
