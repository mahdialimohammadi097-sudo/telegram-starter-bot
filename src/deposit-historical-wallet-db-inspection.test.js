import test from "node:test";
import assert from "node:assert/strict";
import {inspectHistoricalWalletFromDatabase as inspect} from "./deposit-historical-wallet-db-inspection.js";
const address="0x"+"a".repeat(40);
const input={walletAddress:address,eventBlockNumber:"150",expectedUserId:"12"};
const row={wallet_id:"1",user_id:"12",chain_id:"56",wallet_address:address,start_block:"100",end_block:"200",wallet_id_current:"1",wallet_chain_id:"56",wallet_address_current:address,is_platform_controlled:true};
test("read-only history lookup validates ownership and binds event block",async()=>{
 let sql,params;
 const client={query:async(q,p)=>{sql=q;params=p;return {rows:[row]};}};
 assert.deepEqual(await inspect(client,input),{walletId:"1",userId:"12"});
 assert.match(sql,/LIMIT 2\s+FOR SHARE OF h,w/);
 assert.deepEqual(params,[address,"150"]);
});
test("history lookup fails closed for missing, ambiguous and forged wallet rows",async()=>{
 for(const rows of [[],[row,row],[{...row,wallet_address_current:"0x"+"b".repeat(40)}],
 [{...row,is_platform_controlled:false}],[{...row,user_id:"13"}]]){
  await assert.rejects(inspect({query:async()=>({rows})},input));
 }
});
test("history lookup rejects wrong chain, identity and block boundaries",async()=>{
 const cases=[
  {...row,chain_id:"97"},
  {...row,wallet_chain_id:"97"},
  {...row,wallet_id_current:"2"},
  {...row,start_block:"151"},
  {...row,end_block:"150"},
  {...row,wallet_address:"0x"+"b".repeat(40)},
  {...row,is_platform_controlled:null}
 ];
 for(const candidate of cases){
  await assert.rejects(inspect({query:async()=>({rows:[candidate]})},input));
 }
});
test("history lookup rejects schema injection before any database query",async()=>{
 const client={query:async()=>{throw Error("query should not run")}};
 await assert.rejects(inspect(client,{...input,schema:"public;DROP TABLE wallets"}),/Invalid schema/);
 await assert.rejects(inspect(client,{...input,schema:"Public"}),/Invalid schema/);
});
test("history lookup rejects invalid addresses and block numbers before query",async()=>{
 const client={query:async()=>{throw Error("query should not run")}};
 await assert.rejects(inspect(client,{...input,eventBlockNumber:"1 OR 1=1"}),/Invalid/);
 await assert.rejects(inspect(client,{...input,eventBlockNumber:"1".repeat(79)}),/Invalid/);
 await assert.rejects(inspect(client,{...input,expectedUserId:"9223372036854775808"}),/Invalid/);
 await assert.rejects(inspect(client,{...input,expectedUserId:"1".repeat(500)}),/Invalid/);
 await assert.rejects(inspect(client,{...input,walletAddress:"invalid"}),/Invalid/);
});

test("history lookup rejects malformed database responses",async()=>{
 for(const result of [null,undefined,{}, {rows:null}, {rows:{}},
   {rows:[row],rowCount:0}, {rows:[row],rowCount:2}]){
  await assert.rejects(inspect({query:async()=>result},input),/Missing or ambiguous/);
 }
});
