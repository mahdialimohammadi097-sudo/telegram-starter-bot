// Offline-only guard. Does not verify chain finality or credit balances.
// The event identity is chain ID + transaction hash + log index.
export function normalizeDepositEventIdentity({chainId,transactionHash,logIndex}) {
 if (chainId !== 56) throw new TypeError("Unsupported chain");
 if (typeof transactionHash !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(transactionHash))
  throw new TypeError("Invalid transaction hash");
 if ((typeof logIndex !== "string" && typeof logIndex !== "number") ||
     (typeof logIndex === "number" && !Number.isSafeInteger(logIndex)) ||
     !/^(0|[1-9][0-9]*)$/.test(String(logIndex)))
  throw new TypeError("Invalid log index");
 const index=BigInt(logIndex);
 if(index > 4294967295n) throw new RangeError("Log index exceeds uint32");
 return "bsc:56:"+transactionHash.toLowerCase()+":"+index.toString();
}
