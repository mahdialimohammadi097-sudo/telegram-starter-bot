// A pure guard for verified blockchain evidence and an independently queried
// wallet ownership result. This does not query the database or post funds.
// Callers must resolve assignments in the same transaction used for crediting.
const ADDRESS = /^0x[0-9a-f]{40}$/i;
const ID = /^[1-9][0-9]{0,18}$/;
const EVENT_KEY = /^bsc:56:0x[0-9a-f]{64}:(0|[1-9][0-9]{0,77})$/;
const MAX_UINT256 = (1n << 256n) - 1n;
const nonzeroAddress = value => typeof value === "string" &&
  ADDRESS.test(value) && !/^0x0{40}$/i.test(value);
export function isCanonicalDepositEventKey(value) {
  if (typeof value !== "string") return false;
  const match = EVENT_KEY.exec(value);
  return match !== null && BigInt(match[1]) <= MAX_UINT256;
}


export function isValidDepositDatabaseId(value) {
  if (typeof value === "number" && !Number.isSafeInteger(value)) return false;
  if (!["number", "string", "bigint"].includes(typeof value)) return false;
  const text = String(value);
  return ID.test(text) && BigInt(text) <= 9223372036854775807n;
}
export function requireUniqueDepositOwner(evidence, assignments) {
  if (!evidence || !nonzeroAddress(evidence.depositAddress) || !nonzeroAddress(evidence.tokenContract) ||
      evidence.chainId !== "56" || !isCanonicalDepositEventKey(evidence.eventKey) ||
      typeof evidence.ledgerAmount !== "string" ||
      !/^(?:0|[1-9][0-9]*)\.[0-9]{8}$/.test(evidence.ledgerAmount) ||
      !Array.isArray(assignments) || !/[1-9]/.test(evidence.ledgerAmount)) throw new Error("Invalid deposit attribution evidence");
  // Multiple rows are unsafe even when they name the same user: they may
  // represent reused addresses or stale assignments.
  if (assignments.length !== 1) throw new Error("Deposit address must have exactly one active owner");
  const owner = assignments[0];
  if (!owner || owner.active !== true || !isValidDepositDatabaseId(owner.userId) ||
      typeof owner.address !== "string" || !ADDRESS.test(owner.address) ||
      owner.address.toLowerCase() !== evidence.depositAddress.toLowerCase() ||
      owner.chainId !== 56 || owner.currency !== "USDT" ||
      typeof owner.tokenContract !== "string" || !ADDRESS.test(owner.tokenContract) ||
      owner.tokenContract.toLowerCase() !== evidence.tokenContract.toLowerCase()) {
    throw new Error("Deposit wallet ownership mismatch");
  }
  return Object.freeze({
    userId: String(owner.userId),
    eventKey: evidence.eventKey,
    depositAddress: evidence.depositAddress.toLowerCase(),
    ledgerAmount: evidence.ledgerAmount
  });
}
