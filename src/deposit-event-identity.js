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

// Accept only the canonical serialized identity, with bounded parsing.
export function isCanonicalDepositEventKey(value){
 if(typeof value!=="string")return false;
 const match=/^bsc:56:(0x[0-9a-f]{64}):(0|[1-9][0-9]{0,9})$/.exec(value);
 if(!match)return false;
 try{return normalizeDepositEventIdentity({chainId:56,transactionHash:match[1],logIndex:match[2]})===value;}catch{return false;}
}
