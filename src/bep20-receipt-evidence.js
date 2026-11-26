// Pure validation of independently fetched BSC receipt and confirmation depth.
// Confirmation depth alone is not independent proof of chain finality.
// No RPC client, bot input, or ledger side effects. A trusted reader must supply
// receipt, transaction, canonical block and head from its own verified RPC.
const HEX64 = /^0x[0-9a-f]{64}$/;
const ADDRESS = /^0x[0-9a-f]{40}$/;
const UINT = /^(0|[1-9][0-9]{0,77})$/;
const MAX_UINT256 = (1n << 256n) - 1n;
const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const addressTopic = value => "0x" + "0".repeat(24) + value.slice(2);
const validHash = value => typeof value === "string" && HEX64.test(value);
function quantity(value) {
  if (typeof value !== "string" || !/^0x(?:0|[1-9a-f][0-9a-f]{0,63})$/.test(value)) throw new Error("Invalid RPC quantity");
  return BigInt(value);
}
function logQuantity(value) {
  if (typeof value === "number" && !Number.isSafeInteger(value)) throw new Error("Unsafe log index");
  if (typeof value !== "string" && typeof value !== "number") throw new Error("Invalid log index");
  if (typeof value === "string" && value.startsWith("0x")) return quantity(value.toLowerCase());
  if (!UINT.test(String(value))) throw new Error("Invalid log index");
  const index = BigInt(value);
  if (index > MAX_UINT256) throw new Error("Invalid log index: exceeds uint256");
  return index;
}
export function verifyBep20DepositReceipt({receipt, transaction, block, head, tokenContract, depositAddress, minConfirmations = 20}) {
  if (typeof tokenContract !== "string" || typeof depositAddress !== "string" ||
      !ADDRESS.test(tokenContract) || !ADDRESS.test(depositAddress) ||
      [tokenContract,depositAddress].some(address=>address==="0x"+"0".repeat(40)) ||
      !Number.isSafeInteger(minConfirmations) || minConfirmations < 1) throw new Error("Invalid trusted receipt configuration");
  if (!receipt || !transaction || !block || !validHash(receipt.transactionHash) ||
      !validHash(receipt.blockHash) || !validHash(block.hash) ||
      receipt.blockHash !== block.hash || receipt.status !== "0x1" ||
      receipt.transactionHash !== transaction.hash || transaction.blockHash !== block.hash ||
      receipt.blockNumber !== block.number || transaction.blockNumber !== block.number) throw new Error("Receipt not in canonical successful block");
  if (receipt.transactionIndex !== undefined || transaction.transactionIndex !== undefined) {
    if (quantity(receipt.transactionIndex) !== quantity(transaction.transactionIndex)) throw new Error("Inconsistent transaction index");
  }
  const height = quantity(block.number), tip = quantity(head);
  if (tip < height || tip - height + 1n < BigInt(minConfirmations)) throw new Error("Insufficient confirmations");
  if (!Array.isArray(receipt.logs)) throw new Error("Missing receipt logs");
  const expectedTo = addressTopic(depositAddress.toLowerCase());
  const results = [];
  const seenIndices = new Set();
  for (const log of receipt.logs) {
    if (!log || typeof log !== "object") throw new Error("Malformed receipt log");
    const index = logQuantity(log.logIndex);
    const indexKey = index.toString();
    if (seenIndices.has(indexKey)) throw new Error("Duplicate transfer log index");
    seenIndices.add(indexKey);
    if (typeof log.address !== "string" || log.address.toLowerCase() !== tokenContract.toLowerCase()) continue;
    if (!Array.isArray(log.topics) || typeof log.topics[0] !== "string" || log.topics[0].toLowerCase() !== TRANSFER_TOPIC) continue;
    if (log.topics.length !== 3 || !/^0x[0-9a-fA-F]{64}$/.test(log.topics[1]) ||
        typeof log.topics[2] !== "string" || log.topics[2].toLowerCase() !== expectedTo ||
        typeof log.data !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(log.data)) continue;
    const senderTopic = log.topics[1];
    if (typeof senderTopic !== "string" || !/^0x0{24}[0-9a-fA-F]{40}$/.test(senderTopic) ||
        senderTopic.toLowerCase() === expectedTo || senderTopic.toLowerCase() === "0x" + "0".repeat(64)) {
      throw new Error("Invalid transfer sender");
    }
    const amount = BigInt(log.data);
    if (log.transactionIndex !== undefined || receipt.transactionIndex !== undefined) {
      if (quantity(log.transactionIndex) !== quantity(receipt.transactionIndex)) throw new Error("Inconsistent transfer transaction index");
    }
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
