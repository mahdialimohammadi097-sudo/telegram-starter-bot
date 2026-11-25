// Disposable simulation review only. One consistent, read-only snapshot.
// The supplied reserve, fee and clearing accounts belong to this single fixture.
import {runReadOnlyDepositAudit} from "../src/read-only-deposit-audit.js";
import {findSimulationDiscrepancies} from "./reconcile-simulated-deposits.js";
import {findSettlementDiscrepancies} from "./reconcile-simulated-settlements.js";
import {findWithdrawalDiscrepancies} from "./reconcile-simulated-withdrawals.js";
import {reconcileSimulatedLiabilities} from "./reconcile-simulated-liabilities.js";

async function countOpeningDiscrepancies(client){
  const {rows}=await client.query(`
    WITH expected AS (
      SELECT i.id,i.principal,a.id AS available_id,h.id AS invested_id
      FROM simulation_investments i
      LEFT JOIN ledger_accounts a ON a.user_id=i.user_id AND a.account_type='AVAILABLE' AND a.currency='USDT'
      LEFT JOIN ledger_accounts h ON h.user_id=i.user_id AND h.account_type='INVESTED' AND h.currency='USDT'
    ), actual AS (
      SELECT j.*,count(*) OVER(PARTITION BY reference_id) AS copies
      FROM ledger_transactions j WHERE transaction_type='simulated-investment-open'
    )
    SELECT count(*)::text AS discrepancies
    FROM expected i FULL JOIN actual j ON j.reference_id=i.id::text
    WHERE i.id IS NULL OR j.id IS NULL OR j.copies<>1
       OR j.status IS DISTINCT FROM 'posted'
       OR j.idempotency_key IS DISTINCT FROM 'simulated-investment-open:'||i.id
       OR (SELECT count(*) FROM ledger_entries e WHERE e.transaction_id=j.id)<>2
       OR NOT EXISTS (SELECT 1 FROM ledger_entries e WHERE e.transaction_id=j.id AND e.account_id=i.available_id
            AND e.entry_type='debit' AND e.amount=i.principal AND e.currency='USDT')
       OR NOT EXISTS (SELECT 1 FROM ledger_entries e WHERE e.transaction_id=j.id AND e.account_id=i.invested_id
            AND e.entry_type='credit' AND e.amount=i.principal AND e.currency='USDT')
  `);
  if(rows?.length!==1 || !/^(0|[1-9][0-9]*)$/.test(rows[0].discrepancies)) throw new Error("Incomplete opening reconciliation");
  return rows[0].discrepancies;
}
export async function auditSimulatedWorkflow(pool,{schema,clearingId,reserveId,feeId}){
  if(typeof schema!=="string" || !/^workflow_review_[a-f0-9]{32}$/.test(schema)) throw new Error("Disposable workflow review schema required");
  return runReadOnlyDepositAudit(pool,async client=>{
    const security=await client.query("SET LOCAL row_security=off");
    const path=await client.query('SET LOCAL search_path=pg_catalog,"'+schema+'",pg_temp');
    if(security.command!=="SET"||path.command!=="SET") throw new Error("Workflow audit settings unconfirmed");
    const {rows:[state]}=await client.query("SELECT current_setting('row_security') AS security,current_schemas(false) AS schemas");
    if(state.security!=="off" || !state.schemas.includes(schema)) throw new Error("Workflow audit schema unavailable");
    const deposit=await findSimulationDiscrepancies(client,clearingId);
    const opening=await countOpeningDiscrepancies(client);
    const settlement=await findSettlementDiscrepancies(client,reserveId,feeId);
    const withdrawal=await findWithdrawalDiscrepancies(client);
    const liabilities=await reconcileSimulatedLiabilities(client);
    const counts={deposits:String(deposit.length),openings:opening,settlements:String(settlement.length),
      withdrawals:String(withdrawal.length),...liabilities.counts};
    return {scope:"disposable-simulation-workflow",counts,
      clean:Object.values(counts).every(n=>n==="0"),custodyVerified:false,productionReady:false};
  });
}
