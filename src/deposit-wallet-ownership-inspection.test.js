import test from "node:test";
import assert from "node:assert/strict";
import {inspectDepositWalletOwnership} from "./deposit-wallet-ownership-inspection.js";
const address="0x"+"d".repeat(40);
const row={user_id:12,wallet_id:9,status:"active",ended_at:null,assignment_type:"deposit",
 wallet:{status:"active",chain_id:56,is_platform_controlled:true,wallet_address:address}};
const valid={evidence:{depositAddress:address},assignments:[row],expectedUserId:12,
 ledgerAccount:{id:44,user_id:12,currency:"USDT"}};
test("matches unique active wallet, user and ledger account",()=>{
 assert.deepEqual(inspectDepositWalletOwnership(valid),{userId:12,walletId:9,accountId:44});
});
test("rejects wrong user, wrong ledger owner, duplicate assignment, wrong chain and disabled wallet",()=>{
 const cases=[
 {...valid,expectedUserId:13},
 {...valid,ledgerAccount:{...valid.ledgerAccount,user_id:13}},
 {...valid,assignments:[row,row]},
 {...valid,assignments:[{...row,wallet:{...row.wallet,chain_id:97}}]},
 {...valid,assignments:[{...row,wallet:{...row.wallet,status:"disabled"}}]},
 {...valid,assignments:[{...row,ended_at:"2026-01-01"}]},
 {...valid,assignments:[{...row,wallet:{...row.wallet,is_platform_controlled:false}}]}
 ];
 for(const value of cases)assert.throws(()=>inspectDepositWalletOwnership(value),/ownership mismatch/);
});

test("rejects missing or invalid wallet and ledger identifiers",()=>{
 for(const value of [
  {...valid,ledgerAccount:{...valid.ledgerAccount,id:undefined}},
  {...valid,ledgerAccount:{...valid.ledgerAccount,id:-1}},
  {...valid,assignments:[{...row,wallet_id:undefined}]},
  {...valid,assignments:[{...row,user_id:"12"}]}
 ])assert.throws(()=>inspectDepositWalletOwnership(value),/ownership mismatch/);
});
