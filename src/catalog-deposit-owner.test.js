import test from "node:test";
import assert from "node:assert/strict";
import { createCatalogDepositOwnerResolver } from "./catalog-deposit-owner.js";
import { requireUniqueDepositOwner } from "./deposit-owner-guard.js";
const tokenContract = "0x" + "a".repeat(40);
const depositAddress = "0x" + "b".repeat(40);
const evidence = { tokenContract, depositAddress, chainId: "56",
  eventKey: "bsc:56:0x" + "c".repeat(64) + ":0", ledgerAmount: "10.00000000" };
const row = { user_id: "123", wallet_address: depositAddress, active: true };
function mock(rows, overrides = {}) {
  const calls = [];
  return { calls, async query(sql, params) {
    calls.push({sql, params});
    if (sql.startsWith("SET LOCAL")) return {command:"SET"};
    if (sql.includes("deposit_owner_tx', true")) return {rows:[{marker:overrides.marker ?? "active"}]};
    if (sql.includes("current_setting('row_security')")) return {rows:[{row_security:overrides.visibility ?? "off",lock_timeout:overrides.timeout ?? "2s"}]};
    if (sql.startsWith("LOCK TABLE")) {
      if(overrides.lockError) throw overrides.lockError;
      return {command:overrides.lockCommand ?? "LOCK"};
    }
    return {rows,rowCount:overrides.rowCount ?? rows.length};
  }};
}
const resolve = createCatalogDepositOwnerResolver({tokenContract});
test("valid owner and lock before lookup", async () => {
  const client = mock([row]);
  const result = await resolve(client, evidence);
  assert.equal(requireUniqueDepositOwner(evidence, result).userId, "123");
  assert.match(client.calls[5].sql, /SHARE ROW EXCLUSIVE/);
  assert.deepEqual(client.calls[6].params, [depositAddress]);
});
test("reject unknown chain or token before database access", async () => {
  for (const change of [{chainId:"1"}, {tokenContract:depositAddress}, {depositAddress:"bad"}, {depositAddress:"0x"+"0".repeat(40)}]) {
    const client = mock([]);
    await assert.rejects(resolve(client, {...evidence,...change}));
    assert.equal(client.calls.length, 0);
  }
});
test("reject missing, ambiguous and inactive assignments", async () => {
  for (const rows of [[], [row,row], [{...row, active:false}], [row,{...row,user_id:"456",active:false}]]) {
    const result = await resolve(mock(rows), evidence);
    assert.throws(() => requireUniqueDepositOwner(evidence,result));
  }
});
test("lock failure propagates without ownership lookup", async () => {
  const client = mock([], {lockError:new Error("lock timeout")});
  await assert.rejects(resolve(client,evidence), /lock timeout/);
  assert.equal(client.calls.length,6);
});

test("reject invalid trusted token configuration", () => {
  for (const value of [undefined, "", "USDT", "0x123", null, "0x"+"0".repeat(40)]) {
    assert.throws(() => createCatalogDepositOwnerResolver({tokenContract:value}), TypeError);
  }
});
test("normalize address and contract case while retaining owner attribution", async () => {
  const client = mock([{...row, wallet_address:depositAddress.toUpperCase().replace("0X","0x")}]);
  const upperEvidence = {...evidence, depositAddress:depositAddress.toUpperCase().replace("0X","0x"),
    tokenContract:tokenContract.toUpperCase().replace("0X","0x")};
  const owners = await resolve(client,upperEvidence);
  assert.equal(requireUniqueDepositOwner(upperEvidence,owners).userId,"123");
  assert.deepEqual(client.calls[6].params,[depositAddress]);
});
test("fail closed if transaction boundary is absent", async () => {
  const client=mock([], {marker:""});
  await assert.rejects(resolve(client,evidence), /Explicit database transaction required/);
  assert.equal(client.calls.length,2);
});


test("refuse unconfirmed ownership visibility and lock limits before lookup",async()=>{
 for(const overrides of [{visibility:"on"},{timeout:"0"}]){
  const client=mock([row],overrides);
  await assert.rejects(resolve(client,evidence),/visibility or lock limit unconfirmed/);
  assert.equal(client.calls.length,5);
 }
 const client=mock([row],{lockCommand:"SELECT"});
 await assert.rejects(resolve(client,evidence),/lock unconfirmed/);
 assert.equal(client.calls.length,6);
});
test("refuse incomplete ownership row count",async()=>{
 await assert.rejects(resolve(mock([row],{rowCount:2}),evidence),/Incomplete deposit ownership result/);
});
