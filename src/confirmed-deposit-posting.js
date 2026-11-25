import { requireUniqueDepositOwner, isValidDepositDatabaseId } from "./deposit-owner-guard.js";
import { bep20BaseUnitsToLedgerAmount } from "./bep20-ledger-precision.js";
import { withLedgerTransaction, postJournalInTransaction } from "./ledger-posting.js";

// Not wired to the bot. Evidence must come from the trusted receipt reader,
// never from Telegram input. A production ownership adapter requires a fresh
// catalog audit: it must lock the address namespace against inserts/reassignment
// and return ALL assignments, with active=false for inactive users/wallets.
// Those locks must remain held on this client until COMMIT/ROLLBACK.
export async function postConfirmedDeposit({ pool, evidence, clearingAccountId,
  resolveAndLockAssignments, persistVerifiedEvidence }) {
  if (typeof persistVerifiedEvidence !== "function") {
    throw new TypeError("Durable verified evidence persistence is required before posting");
  }
  if (typeof resolveAndLockAssignments !== "function") {
    throw new TypeError("A reviewed transactional ownership adapter is required");
  }
  // Snapshot before the first await; callers cannot mutate the credited amount.
  const verified = { ...evidence };
  if (bep20BaseUnitsToLedgerAmount(verified.amountBaseUnits) !== verified.ledgerAmount) {
    throw new Error("Deposit amount does not match blockchain evidence");
  }
  if (typeof verified.eventKey !== "string" ||
      !/^bsc:56:0x[0-9a-f]{64}:(?:0|[1-9][0-9]*)$/.test(verified.eventKey)) {
    throw new Error("Deposit event key must be canonical");
  }
  if (!isValidDepositDatabaseId(clearingAccountId)) throw new Error("Invalid clearing account");
  const clearing = String(clearingAccountId);
  Object.freeze(verified);
  return withLedgerTransaction(pool, async client => {
    // Lock event before accounts, matching the ledger's global lock order.
    const key = "confirmed-deposit:" + verified.eventKey;
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [key]);
    const assignments = await resolveAndLockAssignments(client, verified);
    const owner = requireUniqueDepositOwner(verified, assignments);
    // Evidence and journal must commit or roll back together.
    await persistVerifiedEvidence(client, verified);
    const accounts = await client.query(
      `SELECT id, user_id, account_type, currency FROM ledger_accounts
       WHERE id = $1 OR (user_id = $2 AND account_type = 'AVAILABLE' AND currency = 'USDT')
       ORDER BY id FOR UPDATE`, [clearing, owner.userId]);
    const source = accounts.rows.find(a => String(a.id) === clearing);
    const destinations = accounts.rows.filter(a => String(a.user_id) === owner.userId &&
      a.account_type === "AVAILABLE" && a.currency === "USDT");
    if (!source || source.user_id !== null || source.account_type !== "CLEARING" ||
        source.currency !== "USDT" || destinations.length !== 1) {
      throw new Error("Deposit ledger account ownership mismatch");
    }
    // Stable metadata binds replay to user/address/contract as well as amount.
    // A conflicting retry must fail even if it names the same blockchain event.
    return postJournalInTransaction(client, {
      transactionType: "confirmed-deposit", referenceId: owner.eventKey, idempotencyKey: key,
      description: JSON.stringify({ userId: owner.userId, address: owner.depositAddress,
        tokenContract: verified.tokenContract.toLowerCase() }),
      entries: [
        { account_id: clearing, entry_type: "debit", amount: owner.ledgerAmount, currency: "USDT" },
        { account_id: String(destinations[0].id), entry_type: "credit", amount: owner.ledgerAmount, currency: "USDT" }
      ]
    });
  });
}
