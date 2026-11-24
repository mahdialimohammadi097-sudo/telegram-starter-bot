// Read-only BSC JSON-RPC snapshot. Never accepts receipt data from Telegram.
// Caller supplies a trusted RPC transport and independently configured chain.
import {verifyBep20DepositReceipt} from "./bep20-receipt-evidence.js";
const HASH=/^0x[0-9a-f]{64}$/;
const ADDRESS=/^0x[0-9a-f]{40}$/;
const QUANTITY=/^0x(?:0|[1-9a-f][0-9a-f]{0,63})$/;
export async function readVerifiedBep20Deposit({
  rpc, transactionHash, tokenContract, depositAddress, minConfirmations=20
}) {
  if (typeof rpc !== "function" || typeof transactionHash !== "string" || !HASH.test(transactionHash) ||
      typeof tokenContract !== "string" || !ADDRESS.test(tokenContract) ||
      typeof depositAddress !== "string" || !ADDRESS.test(depositAddress) ||
      !Number.isSafeInteger(minConfirmations) || minConfirmations < 1) throw new Error("Invalid trusted RPC reader");
  const request = async (method, params) => {
    let result;
    try {
      result = structuredClone(await rpc(method,params));
    } catch {
      throw new Error("Trusted RPC request failed");
    }
    if (result === null || result === undefined) throw new Error("Missing RPC response: "+method);
    return result;
  };
  const chainId = await request("eth_chainId",[]);
  if (chainId !== "0x38") throw new Error("Unexpected RPC chain");
  const receipt = await request("eth_getTransactionReceipt",[transactionHash]);
  const transaction = await request("eth_getTransactionByHash",[transactionHash]);
  if (receipt.transactionHash !== transactionHash || transaction.hash !== transactionHash ||
      typeof receipt.blockNumber !== "string" || !QUANTITY.test(receipt.blockNumber))
    throw new Error("RPC transaction identity mismatch");
  const block = await request("eth_getBlockByNumber",[receipt.blockNumber,false]);
  const head = await request("eth_blockNumber",[]);
  const secondReceipt = await request("eth_getTransactionReceipt",[transactionHash]);
  if (secondReceipt.transactionHash !== receipt.transactionHash ||
      secondReceipt.blockHash !== receipt.blockHash || secondReceipt.blockNumber !== receipt.blockNumber ||
      secondReceipt.status !== receipt.status) throw new Error("Receipt changed during verification");
  // Canonical lookup must follow the last receipt read.
  const canonical = await request("eth_getBlockByNumber",[receipt.blockNumber,false]);
  if (canonical.hash !== block.hash || canonical.number !== block.number)
    throw new Error("Canonical block changed during receipt verification");
  const verify = snapshot => verifyBep20DepositReceipt({receipt:snapshot,transaction,block:canonical,head,
    tokenContract,depositAddress,minConfirmations});
  const first = verify(receipt), second = verify(secondReceipt);
  const normalize = events => events.map(event => JSON.stringify(event)).sort();
  if (JSON.stringify(normalize(first)) !== JSON.stringify(normalize(second)))
    throw new Error("Transfer evidence changed during verification");
  return second;
}
