import test from "node:test";
import assert from "node:assert/strict";
import { inspectDepositWalletSchema } from "./deposit-wallet-schema-preflight.js";
test("missing production wallet columns fail closed", async()=>{
 const pool={query:async()=>({rows:[{table_name:"users",column_name:"id",data_type:"bigint",is_nullable:"NO"}]})};
 const result=await inspectDepositWalletSchema(pool);
 assert.equal(result.readyForIntegration,false);
 assert.equal(result.realDepositsEnabled,false);
 assert.ok(result.missing.includes("user_wallet_assignments.user_id"));
});
test("schema inspector uses only a read-only catalog query",async()=>{
 let sql="";
 const pool={query:async(q)=>{sql=q;return {rows:[]}}};
 await inspectDepositWalletSchema(pool);
 assert.match(sql,/information_schema.columns/);
 assert.doesNotMatch(sql,/\b(?:INSERT|UPDATE|DELETE|ALTER|CREATE)\b/i);
});
