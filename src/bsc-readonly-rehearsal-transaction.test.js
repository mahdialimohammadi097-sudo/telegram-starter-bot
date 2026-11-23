import test from "node:test";
import assert from "node:assert/strict";
import {rehearseBscDepositJournal} from "./bsc-deposit-readonly-rehearsal.js";

test("read-only rehearsal rolls back on failed BSC evidence and never commits",async()=>{
 const statements=[];
 const client={query:async(sql)=>{
  statements.push(sql);
  if(sql==="BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY" ||
     sql.startsWith("SET LOCAL") || sql==="ROLLBACK")return {rows:[]};
  throw new Error("Unexpected SQL in invalid-evidence path");
 }};
 await assert.rejects(rehearseBscDepositJournal({
  client,rpc:async()=>{throw new Error("RPC must not be contacted")},
  transactionHash:"invalid",expected:{depositAddress:"invalid"}
 }),/Invalid approved deposit address/);
 assert.deepEqual(statements,[
  "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY",
  "SET LOCAL lock_timeout = '2000ms'",
  "SET LOCAL statement_timeout = '8000ms'",
  "ROLLBACK"
 ]);
 assert.equal(statements.includes("COMMIT"),false);
});

test("rehearsal requires a dedicated query client before beginning",async()=>{
 await assert.rejects(rehearseBscDepositJournal({client:null}),/Dedicated PostgreSQL client required/);
});

test("rollback failure fails closed with rollback error",async()=>{
 const client={query:async(sql)=>{
  if(sql==="ROLLBACK")throw new Error("connection lost");
  if(sql.startsWith("BEGIN") || sql.startsWith("SET LOCAL"))return {rows:[]};
  throw new Error("Unexpected query");
 }};
 await assert.rejects(rehearseBscDepositJournal({
  client,transactionHash:"invalid",expected:{depositAddress:"invalid"}
 }),/Read-only rehearsal rollback failed/);
});
