import test from "node:test";
import assert from "node:assert/strict";
import {createDisabledDepositIngestion} from "./deposit-ingestion-gate.js";
test("financial ingestion gate cannot be enabled by configuration",()=>{
 assert.throws(()=>createDisabledDepositIngestion({enabled:true}),/separately reviewed/);
 assert.throws(()=>createDisabledDepositIngestion({approvedRelease:true}),/separately reviewed/);
});
test("financial posting remains disabled and no RPC is called",async()=>{
 let calls=0;
 const gate=createDisabledDepositIngestion({rpc:async()=>{calls++;throw Error("unexpected")}});
 await assert.rejects(gate.post(),/disabled/);
 assert.equal(calls,0);
});
test("read-only inspection requires a trusted RPC",async()=>{
 const gate=createDisabledDepositIngestion();
 await assert.rejects(gate.inspect({transactionHash:"0x"+"a".repeat(64)}),/Trusted RPC/);
});
