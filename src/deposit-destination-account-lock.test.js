import test from "node:test";
import assert from "node:assert/strict";
import {lockDepositDestinationAccount} from "./deposit-destination-account-lock.js";
test("locks exactly the expected user's AVAILABLE USDT account",async()=>{
 const calls=[];
 const client={query:async(sql,params)=>{calls.push({sql,params});return {rowCount:1,rows:[{id:"44"}]};}};
 assert.equal(await lockDepositDestinationAccount(client,{accountId:"44",userId:"12"}),"44");
 assert.match(calls[0].sql,/FOR UPDATE/);
 assert.match(calls[0].sql,/account_type='AVAILABLE'/);
 assert.deepEqual(calls[0].params,["44","12"]);
});
test("fails closed when account ownership or type is not matched",async()=>{
 const client={query:async()=>({rowCount:0,rows:[]})};
 await assert.rejects(lockDepositDestinationAccount(client,{accountId:"44",userId:"12"}),/unverified/);
 await assert.rejects(lockDepositDestinationAccount(client,{accountId:"-1",userId:"12"}),/Invalid/);
});
