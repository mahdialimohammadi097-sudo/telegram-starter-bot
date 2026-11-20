import { validateBep20Receipt } from "./bep20-receipt-validation.js";
import { bep20BaseUnitsToLedgerAmount } from "./bep20-ledger-precision.js";

const HASH = /^0x[0-9a-f]{64}$/i;
const Q = /^0x(?:0|[1-9a-f][0-9a-f]*)$/i;
const DEFAULT_TIMEOUT_MS = 8000;

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
    const response = await fetchImpl(endpoint.toString(), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: requestId, method, params }),
      signal: AbortSignal.timeout(timeoutMs),
      redirect: "error"
    });
    if (!response.ok) throw new Error("BSC RPC HTTP failure");
    const data = await response.json();
    if (data?.jsonrpc !== "2.0" || data.id !== requestId || data.error || data.result === undefined || data.result === null) {
      throw new Error("Invalid BSC RPC response");
    }
    return data.result;
  }
  return async function inspectDeposit(txHash, logIndex, policy) {
    if (typeof txHash !== "string" || !HASH.test(txHash)) throw new Error("Invalid transaction hash");
    if (typeof logIndex !== "string" || !Q.test(logIndex)) throw new Error("Invalid log index");
    if (!policy || policy.chainId !== 56 && policy.chainId !== "56") throw new Error("Unsupported chain configuration");
    const chainId = await rpc("eth_chainId", []);
    if (chainId !== "0x38") throw new Error("RPC is not BSC mainnet");
    const receipt = await rpc("eth_getTransactionReceipt", [txHash]);
    if (receipt.transactionHash?.toLowerCase() !== txHash.toLowerCase()) throw new Error("RPC receipt mismatch");
    const block = await rpc("eth_getBlockByNumber", [receipt.blockNumber, false]);
    if (!block || !HASH.test(block.hash)) throw new Error("Missing canonical block");
    const head = await rpc("eth_blockNumber", []);
    if (typeof head !== "string" || !Q.test(head)) throw new Error("Invalid RPC head");
    const secondReceipt = await rpc("eth_getTransactionReceipt", [txHash]);
    if (secondReceipt.transactionHash?.toLowerCase() !== receipt.transactionHash.toLowerCase() ||
        secondReceipt.blockHash?.toLowerCase() !== receipt.blockHash.toLowerCase() ||
        secondReceipt.blockNumber !== receipt.blockNumber ||
        secondReceipt.status !== receipt.status) throw new Error("Transaction receipt changed during inspection");
    const evidence = validateBep20Receipt(secondReceipt, logIndex, block, {...policy, confirmedHeadBlock: BigInt(head).toString()});
    const ledgerAmount = bep20BaseUnitsToLedgerAmount(evidence.amountBaseUnits);
    return Object.freeze({ ...evidence, ledgerAmount });
  };
}
