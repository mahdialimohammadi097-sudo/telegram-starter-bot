// A pure guard for verified blockchain evidence and an independently queried
// wallet ownership result. This does not query the database or post funds.
// Callers must resolve assignments in the same transaction used for crediting.
const ADDRESS = /^0x[0-9a-f]{40}$/i;
const ID = /^[1-9][0-9]*$/;
export function requireUniqueDepositOwner(evidence, assignments) {
  if (!evidence || typeof evidence.depositAddress !== "string" ||
      !ADDRESS.test(evidence.depositAddress) || typeof evidence.eventKey !== "string" ||
      !/^bsc:56:0x[0-9a-f]{64}:[0-9]+$/i.test(evidence.eventKey) ||
      typeof evidence.ledgerAmount !== "string" ||
      !/^(?:0|[1-9][0-9]*)\.[0-9]{8}$/.test(evidence.ledgerAmount) ||
      !Array.isArray(assignments)) throw new Error("Invalid deposit attribution evidence");
  // Multiple rows are unsafe even when they name the same user: they may
  // represent reused addresses or stale assignments.
  if (assignments.length !== 1) throw new Error("Deposit address must have exactly one active owner");
  const owner = assignments[0];
  if (!owner || owner.active !== true || !ID.test(String(owner.userId ?? "")) ||
      typeof owner.address !== "string" || !ADDRESS.test(owner.address) ||
      owner.address.toLowerCase() !== evidence.depositAddress.toLowerCase() ||
      owner.chainId !== 56 || owner.currency !== "USDT") {
    throw new Error("Deposit wallet ownership mismatch");
  }
  return Object.freeze({
    userId: String(owner.userId),
    eventKey: evidence.eventKey,
    depositAddress: evidence.depositAddress.toLowerCase(),
    ledgerAmount: evidence.ledgerAmount
  });
}
