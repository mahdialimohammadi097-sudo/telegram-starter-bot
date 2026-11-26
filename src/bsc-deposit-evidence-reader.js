import { isDeepStrictEqual } from "node:util";
import { validateBep20Receipt } from "./bep20-receipt-validation.js";
import { bep20BaseUnitsToLedgerAmount } from "./bep20-ledger-precision.js";

const HASH = /^0x[0-9a-f]{64}$/i;
const Q = /^0x(?:0|[1-9a-f][0-9a-f]{0,63})$/i;
const DEFAULT_TIMEOUT_MS = 8000;
const validHash = value => typeof value === "string" && HASH.test(value);
const validAddress = value => typeof value === "string" && /^0x[0-9a-f]{40}$/i.test(value) && value.toLowerCase() !== "0x"+"0".repeat(40);
function verifyTransaction(receipt, transaction) {
  if (!validHash(transaction?.hash) || !validHash(transaction.blockHash) || !validHash(receipt.blockHash) ||
      transaction.hash.toLowerCase() !== receipt.transactionHash.toLowerCase() ||
      transaction.blockHash.toLowerCase() !== receipt.blockHash.toLowerCase() ||
      transaction.blockNumber !== receipt.blockNumber ||
      transaction.transactionIndex !== receipt.transactionIndex ||
      (transaction.transactionIndex !== undefined && (typeof transaction.transactionIndex !== "string" || !Q.test(transaction.transactionIndex)))) {
    throw new Error("RPC transaction provenance mismatch");
  }
}

export function createBscDepositEvidenceReader({ rpcUrl, fetchImpl = fetch, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  let endpoint;
  try { endpoint = new URL(rpcUrl); } catch { throw new Error("Invalid BSC RPC URL"); }
  if (endpoint.protocol !== "https:" || endpoint.username || endpoint.password || endpoint.hash) {
    throw new Error("BSC RPC must use HTTPS without embedded credentials");
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 30000) throw new Error("Invalid RPC timeout");
  let nextId = 0;
  async function rpc(method, params) {
    const requestId = ++nextId;
    let response, data;
    try {
      response = await fetchImpl(endpoint.toString(), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: requestId, method, params }),
      signal: AbortSignal.timeout(timeoutMs),
      redirect: "error"
    });
      if (!response.ok) throw new Error("BSC RPC HTTP failure");
      data = structuredClone(await response.json());
    } catch {
      // Transport/parser errors can contain the private RPC URL or response.
      throw new Error("BSC RPC request failed");
    }
    if (data?.jsonrpc !== "2.0" || data.id !== requestId || data.error || data.result === undefined || data.result === null) {
      throw new Error("Invalid BSC RPC response");
    }
    return data.result;
  }
  return async function inspectDeposit(txHash, logIndex, policy) {
    if (typeof txHash !== "string" || !HASH.test(txHash)) throw new Error("Invalid transaction hash");
    if (typeof logIndex !== "string" || !Q.test(logIndex)) throw new Error("Invalid log index");
    const configured = Object.freeze({ ...policy });
    if (configured.chainId !== 56 && configured.chainId !== "56") throw new Error("Unsupported chain configuration");
    if (!validAddress(configured.tokenContract) || !validAddress(configured.depositAddress)) throw new Error("Invalid trusted address configuration");
    const chainId = await rpc("eth_chainId", []);
    if (chainId !== "0x38") throw new Error("RPC is not BSC mainnet");
    const receipt = await rpc("eth_getTransactionReceipt", [txHash]);
    if (typeof receipt.transactionHash !== "string" || receipt.transactionHash.toLowerCase() !== txHash.toLowerCase() ||
        typeof receipt.blockNumber !== "string" || !Q.test(receipt.blockNumber)) throw new Error("RPC receipt mismatch");
    const transaction = await rpc("eth_getTransactionByHash", [txHash]);
    verifyTransaction(receipt, transaction);
    const block = await rpc("eth_getBlockByNumber", [receipt.blockNumber, false]);
    if (!validHash(block?.hash)) throw new Error("Missing canonical block");
    const head = await rpc("eth_blockNumber", []);
    if (typeof head !== "string" || !Q.test(head)) throw new Error("Invalid RPC head");
    const secondReceipt = await rpc("eth_getTransactionReceipt", [txHash]);
    if (typeof secondReceipt.transactionHash !== "string" || typeof secondReceipt.blockHash !== "string" ||
        typeof receipt.blockHash !== "string" ||
        secondReceipt.transactionHash.toLowerCase() !== receipt.transactionHash.toLowerCase() ||
        secondReceipt.blockHash?.toLowerCase() !== receipt.blockHash.toLowerCase() ||
        secondReceipt.blockNumber !== receipt.blockNumber ||
        secondReceipt.status !== receipt.status || secondReceipt.transactionIndex !== receipt.transactionIndex) throw new Error("Transaction receipt changed during inspection");
    if (!isDeepStrictEqual(receipt.logs,secondReceipt.logs)) throw new Error("Transfer evidence changed during inspection");
    const secondTransaction = await rpc("eth_getTransactionByHash", [txHash]);
    verifyTransaction(secondReceipt, secondTransaction);
    if (await rpc("eth_chainId", []) !== "0x38") throw new Error("RPC chain changed during inspection");
    const latestHead = await rpc("eth_blockNumber", []);
    if (typeof latestHead !== "string" || !Q.test(latestHead) || BigInt(latestHead) < BigInt(head)) throw new Error("RPC head changed or regressed during inspection");
    const canonical = await rpc("eth_getBlockByNumber", [secondReceipt.blockNumber, false]);
    if (canonical.hash !== block.hash || canonical.number !== block.number) throw new Error("Canonical block changed during inspection");
    const verificationPolicy = {...configured, confirmedHeadBlock: BigInt(head).toString()};
    const firstEvidence = validateBep20Receipt(receipt, logIndex, canonical, verificationPolicy);
    const evidence = validateBep20Receipt(secondReceipt, logIndex, canonical, verificationPolicy);
    // Header equality alone does not establish a consistent transfer observation.
    if (JSON.stringify(firstEvidence) !== JSON.stringify(evidence)) {
      throw new Error("Transfer evidence changed during inspection");
    }
    const ledgerAmount = bep20BaseUnitsToLedgerAmount(evidence.amountBaseUnits);
    // Preserve the canonical hash required by the durable evidence store.
    return Object.freeze({ ...evidence, blockHash: canonical.hash.toLowerCase(), ledgerAmount });
  };
}
