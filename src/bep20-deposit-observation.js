// Offline-only validation for BSC USDT deposit observations.
// This module does not query a chain, move money, or credit balances.
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const HASH = /^0x[0-9a-fA-F]{64}$/;
const UINT = /^(0|[1-9][0-9]{0,77})$/;
const MAX_UINT256 = (1n << 256n) - 1n;

function address(value, label) {
  if (typeof value !== "string" || !ADDRESS.test(value)) throw new TypeError("Invalid " + label);
  return value.toLowerCase();
}
function unsigned(value, label) {
  if ((typeof value !== "string" && typeof value !== "number" && typeof value !== "bigint") ||
      !UINT.test(String(value)) || (typeof value === "number" && !Number.isSafeInteger(value))) {
    throw new TypeError("Invalid " + label);
  }
  const parsed = BigInt(value);
  if (parsed > MAX_UINT256) throw new RangeError("Invalid " + label + ": exceeds uint256");
  return parsed;
}

// All network and contract values must come from reviewed configuration.
// An event alone is never proof of chain finality.
export function validateBep20DepositObservation(event, policy) {
  if (!event || !policy) throw new TypeError("Missing event or policy");
  if (unsigned(policy.chainId, "chain ID") !== 56n) throw new Error("Unsupported network");
  const contract = address(policy.tokenContract, "token contract");
  const recipient = address(policy.depositAddress, "deposit address");
  if ([contract, recipient].some(value => value === "0x" + "0".repeat(40))) {
    throw new Error("Invalid zero token contract or deposit address");
  }
  if (unsigned(policy.tokenDecimals, "token decimals") !== 18n) throw new Error("Unsupported token decimals");
  if (unsigned(event.chainId, "event chain ID") !== 56n) throw new Error("Wrong event network");
  if (address(event.tokenContract, "event token contract") !== contract) throw new Error("Wrong token contract");
  if (address(event.to, "event recipient") !== recipient) throw new Error("Wrong deposit recipient");
  const sender = address(event.from, "event sender");
  if (sender === recipient || sender === "0x" + "0".repeat(40)) throw new Error("Invalid transfer sender");
  if (typeof event.txHash !== "string" || !HASH.test(event.txHash)) throw new TypeError("Invalid transaction hash");
  const logIndex = unsigned(event.logIndex, "log index");
  const amount = unsigned(event.amountBaseUnits, "token amount");
  if (amount === 0n) throw new Error("Zero deposit amount");
  if (event.removed !== false) throw new Error("Removed or unconfirmed log state");
  if (event.receiptStatus !== 1 && event.receiptStatus !== "1") throw new Error("Transaction did not succeed");
  const blockNumber = unsigned(event.blockNumber, "block number");
  const confirmedHead = unsigned(policy.confirmedHeadBlock, "confirmed head block");
  const minConfirmations = unsigned(policy.minConfirmations, "minimum confirmations");
  if (minConfirmations === 0n || confirmedHead < blockNumber ||
      confirmedHead - blockNumber + 1n < minConfirmations) throw new Error("Insufficient confirmations");
  return Object.freeze({
    eventKey: "bsc:56:" + event.txHash.toLowerCase() + ":" + logIndex,
    chainId: "56",
    tokenContract: contract,
    depositAddress: recipient,
    amountBaseUnits: amount.toString(),
    blockNumber: blockNumber.toString()
  });
}
