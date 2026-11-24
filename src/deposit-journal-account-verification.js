// Offline account-identity gate for a proposed deposit journal.
// Rows must come from an independently trusted, transaction-scoped DB lookup.
// This module never authorizes or posts money.
const ID=/^[1-9][0-9]{0,18}$/;
const validId=v=>typeof v==="string"&&ID.test(v)&&BigInt(v)<=9223372036854775807n;
export function verifyDepositJournalAccounts({evidence,userAccount,clearingAccount}){
 if(!evidence || !validId(evidence.userId) ||
    !userAccount || !clearingAccount ||
    !validId(userAccount.id) || !validId(clearingAccount.id) ||
    userAccount.id===clearingAccount.id ||
    userAccount.user_id!==evidence.userId ||
    userAccount.account_type!=="AVAILABLE" ||
    userAccount.currency!=="USDT" ||
    clearingAccount.currency!=="USDT" ||
    clearingAccount.user_id!==null ||
    clearingAccount.account_type!=="CLEARING")
  throw new Error("Deposit journal account identity mismatch");
 return Object.freeze({
  userAvailableAccountId:userAccount.id,
  platformClearingAccountId:clearingAccount.id
 });
}
