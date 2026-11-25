// Offline consistency check only. This is NOT independent proof of chain ownership.
const address=/^0x[0-9a-f]{40}$/;
// PostgreSQL numeric(78,0) can represent numbers above uint256.
// Apply the chain bound independently of the storage precision.
const MAX_UINT256=(1n<<256n)-1n;
const uint=v=>{
 if(typeof v!=="string" || !/^(0|[1-9][0-9]{0,77})$/.test(v)) return null;
 const n=BigInt(v);
 return n<=MAX_UINT256?n:null;
};
const id=v=>typeof v==="string" && /^[1-9][0-9]{0,18}$/.test(v) && BigInt(v)<=9223372036854775807n;
export function verifyHistoricalWalletRecord({history,wallet,eventBlockNumber,expectedUserId,expectedWalletAddress}){
 if(!history || !wallet || !id(history.wallet_id) || !id(history.user_id) ||
    !id(wallet.id) || !id(expectedUserId) || history.wallet_id!==wallet.id ||
    history.user_id!==expectedUserId || !([56,'56'].includes(history.chain_id)) ||
    !([56,'56'].includes(wallet.chain_id)) || wallet.is_platform_controlled!==true ||
    typeof history.wallet_address!=="string" || !address.test(history.wallet_address) ||
    typeof wallet.wallet_address!=="string" || !address.test(wallet.wallet_address) ||
    history.wallet_address!==wallet.wallet_address ||
    typeof expectedWalletAddress!=="string" || !address.test(expectedWalletAddress) ||
    /^0x0{40}$/.test(expectedWalletAddress) || history.wallet_address!==expectedWalletAddress)
   throw new Error("Historical wallet identity mismatch");
 const block=uint(eventBlockNumber),start=uint(history.start_block);
 const end=history.end_block===null?null:uint(history.end_block);
 if(block===null || start===null || (history.end_block!==null && end===null) ||
    (end!==null && end<=start) || block<start || (end!==null && block>=end))
   throw new Error("Historical wallet interval mismatch");
 return Object.freeze({walletId:history.wallet_id,userId:history.user_id});
}
