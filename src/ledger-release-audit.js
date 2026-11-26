// Operator-only diagnostic. Each component owns its bounded read-only
// snapshot. Neither component can authorize production financial activity.
import {auditLedgerIntegrity} from "./ledger-integrity-audit.js";
import {auditLedgerTriggerContract} from "./ledger-trigger-contract-audit.js";

export async function collectLedgerReleaseEvidence(pool,{schema="public"}={}) {
  const integrity=await auditLedgerIntegrity(pool,{schema});
  const triggers=await auditLedgerTriggerContract(pool,{schema});
  return {
    audit:"ledger-release-evidence",scope:"internal-ledger-and-trigger-shape-only",
    sameSnapshot:false,
    integrity, triggers,
    checksPassed:integrity.clean===true&&triggers.compatible===true,
    custodyVerified:false,financialActivationReady:false,productionReady:false
  };
}
