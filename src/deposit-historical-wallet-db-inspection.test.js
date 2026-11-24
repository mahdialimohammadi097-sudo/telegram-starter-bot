import test from "node:test";
import assert from "node:assert/strict";
import {inspectHistoricalWalletSnapshot as inspect} from "./deposit-historical-wallet-db-inspection.js";
const address="0x"+"a".repeat(40);
const input={walletAddress:address,eventBlockNumber:"150",expectedUserId:"12"};
const row={wallet_id:"1",user_id:"12",chain_id:"56",wallet_address:address,start_block:"100",end_block:"200",wallet_id_current:"1",wallet_chain_id:"56",wallet_address_current:address,is_platform_controlled:true};
function fixture(rows){
 const calls=[];
 return {calls,pool:{connect:async()=>({query:async(sql,params)=>{
  calls.push({sql,params});
  if(sql.includes("deposit_address_ownership_history")){
   assert.match(sql,/LEFT JOIN/);assert.doesNotMatch(sql,/FOR SHARE|FOR UPDATE/);
   assert.deepEqual(params,[address,"150"]);
   return {rows,rowCount:rows.length};
  }
  return {command:sql};
 },release(){}})}};
}
test("snapshot reports record consistency only without returning identities",async()=>{
 const f=fixture([row]);
 assert.deepEqual(await inspect(f.pool,input),{recordConsistent:true,independentHistoricalProof:false,financialActivationReady:false,realDepositsEnabled:false});
 assert.match(f.calls[0].sql,/READ ONLY/);
 assert.equal(f.calls.at(-1).sql,"COMMIT");
});
test("snapshot rejects missing, ambiguous, orphaned and mismatched history",async()=>{
 for(const rows of [[],[row,row],[{...row,wallet_id_current:null}],
   [{...row,wallet_address:"0x"+"b".repeat(40),wallet_address_current:"0x"+"b".repeat(40)}],
   [{...row,user_id:"13"}],[{...row,end_block:"150"}]]){
  const f=fixture(rows);await assert.rejects(inspect(f.pool,input));
  assert.equal(f.calls.at(-1).sql,"ROLLBACK");
 }
});
test("invalid inputs cannot access the database",async()=>{
 const pool={connect:async()=>assert.fail("unexpected connection")};
 for(const patch of [{schema:"public;DROP TABLE wallets"},{walletAddress:"0x"+"0".repeat(40)},
  {expectedUserId:"9223372036854775808"},{eventBlockNumber:"1".repeat(79)}]){
  await assert.rejects(inspect(pool,{...input,...patch}),/Invalid/);
 }
});
