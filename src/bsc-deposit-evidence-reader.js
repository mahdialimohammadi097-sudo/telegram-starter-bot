import { validateBep20Receipt } from "./bep20-receipt-validation.js";

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
    const response = await fetchImpl(endpoint.toString(), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++nextId, method, params }),
      signal: AbortSignal.timeout(timeoutMs)
    });
    if (!response.ok) throw new Error("BSC RPC HTTP failure");
    const data = await response.json();
    if (data?.jsonrpc !== "2.0" || data.id !== nextId || data.error || data.result === undefined || data.result === null) {
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
    return validateBep20Receipt(receipt, logIndex, block, {...policy, confirmedHeadBlock: BigInt(head).toString()});
  };
}
