import test from "node:test";
import assert from "node:assert/strict";
import {inspectDepositAssignments,runReadOnlyPreflight} from "../scripts/deposit-preflight.js";

test("flags missing database-enforced wallet ownership uniqueness",async()=>{
 const client={query:async sql=>({rows:sql.includes("COUNT(*)")?[{groups:0}]:[
  {indisunique:true,indisvalid:true,indisready:true,
   definition:"CREATE UNIQUE INDEX one_active_wallet_per_user_type ON public.user_wallet_assignments USING btree (user_id, assignment_type) WHERE status = 'active'"}]})};
 const result=await inspectDepositAssignments(client);
 assert.equal(result.conflictingActiveDepositWallets,0);
 assert.equal(result.activeDepositWalletUniquenessEnforced,false);
});

test("detects conflicting assignments without exposing wallet identifiers",async()=>{
 const client={query:async sql=>({rows:sql.includes("COUNT(*)")?[{groups:2}]:[]})};
 const result=await inspectDepositAssignments(client);
 assert.equal(result.conflictingActiveDepositWallets,2);
 assert.equal(JSON.stringify(result).includes("wallet_id"),false);
});

test("read-only preflight rolls back when catalog audit fails",async()=>{
 const commands=[];
 const client={query:async(sql)=>{
  commands.push(sql);
  if(sql.includes("information_schema.columns")) throw new Error("catalog unavailable");
  return {rows:[]};
 }};
 await assert.rejects(runReadOnlyPreflight(client),/catalog unavailable/);
 assert.match(commands[0],/REPEATABLE READ READ ONLY/);
 assert.equal(commands.at(-1),"ROLLBACK");
 assert.ok(!commands.some(x=>/\b(INSERT|UPDATE|DELETE|CREATE|ALTER|DROP)\b/i.test(x)));
});
