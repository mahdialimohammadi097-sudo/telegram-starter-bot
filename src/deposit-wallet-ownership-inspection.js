// Offline-only cross-check of an independently loaded wallet assignment snapshot.
// Current assignments are NOT proof of ownership at the historical transfer block.
const ADDRESS=/^0x[0-9a-f]{40}$/i;
export function inspectDepositWalletOwnership({evidence,assignments,expectedUserId,ledgerAccount}) {
 const address=evidence?.depositAddress;
 if(typeof address!=="string" || !ADDRESS.test(address) ||
    !Array.isArray(assignments) || !Number.isSafeInteger(expectedUserId) || expectedUserId<=0)
  throw new TypeError("Invalid deposit ownership input");
 const active=assignments.filter(row=>row?.status==="active" && row?.ended_at===null &&
   row?.assignment_type==="deposit" && row?.wallet?.status==="active" &&
   row.wallet.chain_id===56 && row.wallet.is_platform_controlled===true &&
   Number.isSafeInteger(row.wallet_id) && row.wallet_id>0 &&
   Number.isSafeInteger(row.user_id) && row.user_id>0 &&
   typeof row.wallet.wallet_address==="string" &&
   row.wallet.wallet_address.toLowerCase()===address.toLowerCase());
 if(active.length!==1 || active[0].user_id!==expectedUserId ||
    ledgerAccount?.user_id!==expectedUserId || ledgerAccount?.currency!=="USDT" ||
    !Number.isSafeInteger(ledgerAccount?.id) || ledgerAccount.id<=0)
  throw new Error("Deposit wallet or ledger account ownership mismatch");
 return Object.freeze({userId:expectedUserId,walletId:active[0].wallet_id,accountId:ledgerAccount.id});
}
