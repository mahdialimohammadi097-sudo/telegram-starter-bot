import { validateBep20DepositObservation } from "./bep20-deposit-observation.js";

const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const HASH = /^0x[0-9a-f]{64}$/i;
const QUANTITY = /^0x(?:0|[1-9a-f][0-9a-f]{0,63})$/i;
const ADDRESS = /^0x[0-9a-f]{40}$/i;

function quantity(value) {
  if (typeof value !== "string" || !QUANTITY.test(value)) throw new Error("Invalid RPC quantity");
  return BigInt(value);
}
function topicAddress(value) {
  if (typeof value !== "string" || !/^0x0{24}[0-9a-f]{40}$/i.test(value)) throw new Error("Invalid address topic");
  return "0x" + value.slice(-40).toLowerCase();
}

// Inputs must be fetched independently from a trusted BSC RPC and compared with
// canonical block data. This parser NEVER posts to the ledger.
export function validateBep20Receipt(receipt, logIndex, canonicalBlock, policy) {
  if (!receipt || !canonicalBlock || !policy || !Array.isArray(receipt.logs)) throw new Error("Missing RPC evidence");
  if (!HASH.test(receipt.transactionHash) || !HASH.test(receipt.blockHash) ||
      !HASH.test(canonicalBlock.hash) || receipt.blockHash.toLowerCase() !== canonicalBlock.hash.toLowerCase() ||
      quantity(receipt.blockNumber) !== quantity(canonicalBlock.number) ||
      quantity(receipt.status) !== 1n) throw new Error("Receipt failed or canonical block mismatch");
  const index = quantity(logIndex);
  const matches = receipt.logs.filter(log => quantity(log.logIndex) === index);
  if (matches.length !== 1) throw new Error("Transfer log identity mismatch");
  const log = matches[0];
  if (log.removed === true || (log.removed !== undefined && log.removed !== false) || !ADDRESS.test(log.address) || !Array.isArray(log.topics) ||
      log.topics.length !== 3 || log.topics[0].toLowerCase() !== TRANSFER_TOPIC ||
      !HASH.test(log.data) || log.transactionHash?.toLowerCase() !== receipt.transactionHash.toLowerCase() ||
      log.blockHash?.toLowerCase() !== receipt.blockHash.toLowerCase() ||
      quantity(log.blockNumber) !== quantity(receipt.blockNumber)) throw new Error("Invalid transfer log");
  const from = topicAddress(log.topics[1]);
  const to = topicAddress(log.topics[2]);
  if (from === to || from === "0x" + "0".repeat(40)) throw new Error("Invalid transfer sender");
  const result = validateBep20DepositObservation({
    chainId: policy.chainId,
    tokenContract: log.address,
    to,
    from,
    txHash: receipt.transactionHash,
    logIndex: index.toString(),
    amountBaseUnits: BigInt(log.data).toString(),
    removed: false, // A mined receipt log may omit the subscription-only removed flag.
    receiptStatus: 1,
    blockNumber: quantity(receipt.blockNumber).toString()
  }, policy);
  return result;
}
