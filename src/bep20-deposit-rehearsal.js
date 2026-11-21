import {persistVerifiedDepositEvidence} from "./verified-deposit-evidence-store.js";
// Rehearsal-only composition: trusted RPC snapshots -> receipt verification ->
// exact USDT ledger units -> atomic ledger posting. Not wired to production.
import {verifyBep20DepositReceipt} from "./bep20-receipt-evidence.js";
import {bep20BaseUnitsToLedgerAmount} from "./bep20-ledger-precision.js";
import {postConfirmedDeposit} from "./confirmed-deposit-posting.js";

export async function rehearseVerifiedBep20Deposit({
  pool, receipt, transaction, block, head, tokenContract, depositAddress,
  minConfirmations, clearingAccountId, resolveAndLockAssignments
}) {
  const events = verifyBep20DepositReceipt({
    receipt, transaction, block, head, tokenContract, depositAddress, minConfirmations
  });
  // Multiple destination transfers require independent, durable per-event
  // processing. Refuse a partial batch until a queue/outbox is implemented.
  if (events.length !== 1) throw new Error("Multiple matching transfers require durable event processing");
  const event = events[0];
  const ledgerAmount = bep20BaseUnitsToLedgerAmount(event.amountBaseUnits);
  return postConfirmedDeposit({
    pool, clearingAccountId, resolveAndLockAssignments,
    persistVerifiedEvidence: persistVerifiedDepositEvidence,
    evidence: Object.freeze({...event,ledgerAmount})
  });
}
