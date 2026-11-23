// Read-only, transaction-scoped ledger account identity lookup.
// Caller must own an explicit PostgreSQL transaction to retain FOR SHARE locks.
// This module does not post, credit, create accounts or authorize deposits.
import {verifyDepositJournalAccounts} from "./deposit-journal-account-verification.js";
const ID=/^[1-9][0-9]{0,18}$/;
const validId=v=>typeof v==="string"&&ID.test(v)&&BigInt(v)<=9223372036854775807n;
export async function inspectDepositJournalAccounts(client,{
 userId,userAvailableAccountId,platformClearingAccountId,schema="public"
}){
 if(!client || typeof client.query!=="function" ||
    typeof schema!=="string" || !/^[a-z_][a-z0-9_]{0,62}$/.test(schema) ||
    !validId(userId) || !validId(userAvailableAccountId) ||
    !validId(platformClearingAccountId) ||
    userAvailableAccountId===platformClearingAccountId)
  throw new TypeError("Invalid ledger account inspection input");
 const result=await client.query(`
  SELECT id::text,user_id::text,account_type,currency
  FROM "${schema}".ledger_accounts
  WHERE id IN ($1::bigint,$2::bigint)
  ORDER BY id
  FOR SHARE`,[userAvailableAccountId,platformClearingAccountId]);
 if(!result || !Array.isArray(result.rows) || result.rows.length!==2 ||
    (result.rowCount!==undefined && result.rowCount!==2))
  throw new Error("Missing or ambiguous deposit ledger accounts");
 const byId=new Map(result.rows.map(row=>[row?.id,row]));
 if(byId.size!==2)throw new Error("Duplicate deposit ledger account identities");
 return verifyDepositJournalAccounts({
  evidence:{userId},
  userAccount:byId.get(userAvailableAccountId),
  clearingAccount:byId.get(platformClearingAccountId)
 });
}
