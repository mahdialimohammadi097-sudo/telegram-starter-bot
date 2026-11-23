// Offline consistency check only. This is NOT independent proof of chain ownership.
const address=/^0x[0-9a-f]{40}$/;
const uint=v=>typeof v==="string" && /^(0|[1-9][0-9]*)$/.test(v)?BigInt(v):null;
const id=v=>typeof v==="string" && /^[1-9][0-9]*$/.test(v) && BigInt(v)<=9223372036854775807n;
export function verifyHistoricalWalletRecord({history,wallet,eventBlockNumber,expectedUserId}){
 if(!history || !wallet || !id(history.wallet_id) || !id(history.user_id) ||
    !id(wallet.id) || !id(expectedUserId) || history.wallet_id!==wallet.id ||
    history.user_id!==expectedUserId || history.chain_id!==56 ||
    wallet.chain_id!==56 || wallet.is_platform_controlled!==true ||
    typeof history.wallet_address!=="string" || !address.test(history.wallet_address) ||
    typeof wallet.wallet_address!=="string" || !address.test(wallet.wallet_address) ||
    history.wallet_address!==wallet.wallet_address)
   throw new Error("Historical wallet identity mismatch");
 const block=uint(eventBlockNumber),start=uint(history.start_block);
 const end=history.end_block===null?null:uint(history.end_block);
 if(block===null || start===null || (history.end_block!==null && end===null) ||
    (end!==null && end<=start) || block<start || (end!==null && block>=end))
   throw new Error("Historical wallet interval mismatch");
 return Object.freeze({walletId:history.wallet_id,userId:history.user_id});
}
