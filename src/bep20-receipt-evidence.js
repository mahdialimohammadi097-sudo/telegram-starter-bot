// Pure validation of independently fetched BSC receipt and finalized head.
// No RPC client, bot input, or ledger side effects. A trusted reader must supply
// receipt, transaction, canonical block and head from its own verified RPC.
const HEX64 = /^0x[0-9a-f]{64}$/;
const ADDRESS = /^0x[0-9a-f]{40}$/;
const UINT = /^(0|[1-9][0-9]*)$/;
const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const addressTopic = value => "0x" + "0".repeat(24) + value.slice(2);
function quantity(value) {
  if (typeof value !== "string" || !/^0x(?:0|[1-9a-f][0-9a-f]*)$/.test(value)) throw new Error("Invalid RPC quantity");
  return BigInt(value);
}
export function verifyBep20DepositReceipt({receipt, transaction, block, head, tokenContract, depositAddress, minConfirmations = 20}) {
  if (!ADDRESS.test(tokenContract ?? "") || !ADDRESS.test(depositAddress ?? "") ||
      !Number.isSafeInteger(minConfirmations) || minConfirmations < 1) throw new Error("Invalid trusted receipt configuration");
  if (!receipt || !transaction || !block || !HEX64.test(receipt.transactionHash ?? "") ||
      !HEX64.test(receipt.blockHash ?? "") || !HEX64.test(block.hash ?? "") ||
      receipt.blockHash !== block.hash || receipt.status !== "0x1" ||
      receipt.transactionHash !== transaction.hash || transaction.blockHash !== block.hash ||
      receipt.blockNumber !== block.number || transaction.blockNumber !== block.number) throw new Error("Receipt not in canonical successful block");
  const height = quantity(block.number), tip = quantity(head);
  if (tip < height || tip - height + 1n < BigInt(minConfirmations)) throw new Error("Insufficient confirmations");
  if (!Array.isArray(receipt.logs)) throw new Error("Missing receipt logs");
  const expectedTo = addressTopic(depositAddress.toLowerCase());
  const results = [];
  const seenIndices = new Set();
  for (const log of receipt.logs) {
    if (!log || typeof log !== "object") throw new Error("Malformed receipt log");
    if (typeof log.address !== "string" || log.address.toLowerCase() !== tokenContract.toLowerCase()) continue;
    if (!Array.isArray(log.topics) || log.topics[0]?.toLowerCase() !== TRANSFER_TOPIC) continue;
    if (log.topics.length !== 3 || !/^0x[0-9a-fA-F]{64}$/.test(log.topics[1]) ||
        typeof log.topics[2] !== "string" || log.topics[2].toLowerCase() !== expectedTo ||
        !/^0x[0-9a-fA-F]{64}$/.test(log.data ?? "") ||
        !UINT.test(String(log.logIndex ?? "")) && !/^0x(?:0|[1-9a-fA-F][0-9a-fA-F]*)$/.test(log.logIndex ?? "")) continue;
    const index = typeof log.logIndex === "string" && log.logIndex.startsWith("0x") ? quantity(log.logIndex.toLowerCase()) : BigInt(log.logIndex);
    const amount = BigInt(log.data);
    const indexKey = index.toString();
    if (seenIndices.has(indexKey)) throw new Error("Duplicate transfer log index");
    seenIndices.add(indexKey);
    if (amount === 0n || (log.removed !== undefined && log.removed !== false) ||
        log.transactionHash !== receipt.transactionHash ||
        log.blockHash !== block.hash ||
        (log.blockNumber !== undefined && log.blockNumber !== block.number))
      throw new Error("Inconsistent transfer log");
    results.push(Object.freeze({eventKey:`bsc:56:${receipt.transactionHash}:${index}`,
      chainId:"56",tokenContract:tokenContract.toLowerCase(),depositAddress:depositAddress.toLowerCase(),
      amountBaseUnits:amount.toString(),blockHash:block.hash,blockNumber:height.toString()}));
  }
  if (results.length === 0) throw new Error("No matching verified USDT transfer");
  return Object.freeze(results);
}
