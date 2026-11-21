import test from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import {readFile} from "node:fs/promises";
import {persistVerifiedDepositEvidence} from "./verified-deposit-evidence-store.js";
const url=process.env.CATALOG_REHEARSAL_URL;
test("durable receipt evidence is replay-safe and conflicts fail closed", {skip:!url},async()=>{
 const parsed=new URL(url);
 assert.ok(["localhost","127.0.0.1"].includes(parsed.hostname));
 assert.equal(parsed.pathname,"/catalog_rehearsal");
 const pool=new pg.Pool({connectionString:url});
 const client=await pool.connect();
 const eventKey="bsc:56:0x"+"c".repeat(64)+":0";
 const evidence={eventKey,blockHash:"0x"+"d".repeat(64),blockNumber:"100",
 tokenContract:"0x"+"a".repeat(40),depositAddress:"0x"+"b".repeat(40),amountBaseUnits:"1000000000000000000"};
 try{
  await client.query(await readFile(new URL("../test/fixtures/verified-deposit-evidence.sql",import.meta.url),"utf8"));
  assert.equal((await persistVerifiedDepositEvidence(client,evidence)).inserted,true);
  assert.equal((await persistVerifiedDepositEvidence(client,evidence)).inserted,false);
  await assert.rejects(persistVerifiedDepositEvidence(client,{...evidence,blockHash:"0x"+"f".repeat(64)}),/Conflicting/);
  await assert.rejects(persistVerifiedDepositEvidence(client,{...evidence,amountBaseUnits:"2000000000000000000"}),/Conflicting/);
  const count=await client.query("SELECT count(*)::int AS count FROM verified_deposit_evidence");
  assert.equal(count.rows[0].count,1);
 }finally{await client.query("DROP TABLE IF EXISTS verified_deposit_evidence");client.release();await pool.end()}
});
