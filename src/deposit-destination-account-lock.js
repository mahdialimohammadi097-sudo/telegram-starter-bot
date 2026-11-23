// Run inside the same transaction as deposit evidence insertion and journal posting.
// A preflight snapshot is insufficient to authorize a credit to a user account.
export async function lockDepositDestinationAccount(client,{accountId,userId}) {
 if(!client || typeof client.query!=="function" ||
    !/^[1-9][0-9]*$/.test(String(accountId)) ||
    !/^[1-9][0-9]*$/.test(String(userId)))
  throw new TypeError("Invalid destination account lock request");
 const result=await client.query(
  `SELECT id FROM ledger_accounts
   WHERE id=$1::bigint AND user_id=$2::bigint
     AND account_type='AVAILABLE' AND currency='USDT'
   FOR UPDATE`,[String(accountId),String(userId)]);
 if(result.rowCount!==1)
  throw new Error("Deposit destination account ownership is unverified");
 return String(result.rows[0].id);
}
