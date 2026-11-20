// Read-only BSC testnet verifier. Supply expectations from the withdrawal record.
import { readTestnetWithdrawalReceipt } from "../test-support/bsc-testnet-receipt.js";

const [txHash, logIndex, contract, sender, recipient, amount, decimalText] = process.argv.slice(2);
if (!decimalText || !/^\d+$/.test(decimalText)) throw new Error("Expected transaction hash, log index, contract, sender, recipient, amount and decimals");
const decimals = Number(decimalText);
async function rpc(method, params = []) {
  const response = await fetch("https://bsc-testnet-rpc.publicnode.com", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(20000)
  });
  if (!response.ok) throw new Error(method + " returned HTTP " + response.status);
  const data = await response.json();
  if (data.error || !data.result) throw new Error(method + " returned no usable result");
  return data.result;
}
const chainId = await rpc("eth_chainId");
if (chainId !== "0x61") throw new Error("Unexpected network");
const receipt = await rpc("eth_getTransactionReceipt", [txHash]);
const [finalized, canonical] = await Promise.all([
  rpc("eth_getBlockByNumber", ["finalized", false]),
  rpc("eth_getBlockByNumber", [receipt.blockNumber, false])
]);
const result = readTestnetWithdrawalReceipt({
  chainId, receipt, finalizedBlockNumber: finalized.number, canonicalBlockHash: canonical.hash
}, { txHash, logIndex, contract, decimals }, { sender, recipient, amount });
console.log(JSON.stringify({ chainId, block: receipt.blockNumber, ...result }));
