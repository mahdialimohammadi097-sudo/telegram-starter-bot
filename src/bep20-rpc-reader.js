// Read-only BSC JSON-RPC snapshot. Never accepts receipt data from Telegram.
// Caller supplies a trusted RPC transport and independently configured chain.
import {verifyBep20DepositReceipt} from "./bep20-receipt-evidence.js";
const HASH=/^0x[0-9a-f]{64}$/;
export async function readVerifiedBep20Deposit({
  rpc, transactionHash, tokenContract, depositAddress, minConfirmations=20
}) {
  if (typeof rpc !== "function" || !HASH.test(transactionHash ?? "")) throw new Error("Invalid trusted RPC reader");
  const request = async (method, params) => {
    const result = await rpc(method,params);
    if (result === null || result === undefined) throw new Error("Missing RPC response: "+method);
    return result;
  };
  const chainId = await request("eth_chainId",[]);
  if (chainId !== "0x38") throw new Error("Unexpected RPC chain");
  const receipt = await request("eth_getTransactionReceipt",[transactionHash]);
  const transaction = await request("eth_getTransactionByHash",[transactionHash]);
  if (receipt.transactionHash !== transactionHash || transaction.hash !== transactionHash)
    throw new Error("RPC transaction identity mismatch");
  const block = await request("eth_getBlockByNumber",[receipt.blockNumber,false]);
  const head = await request("eth_blockNumber",[]);
  // A second canonical lookup detects head changes during the read.
  const canonical = await request("eth_getBlockByNumber",[receipt.blockNumber,false]);
  if (canonical.hash !== block.hash || canonical.number !== block.number)
    throw new Error("Canonical block changed during receipt verification");
  return verifyBep20DepositReceipt({receipt,transaction,block:canonical,head,
    tokenContract,depositAddress,minConfirmations});
}
