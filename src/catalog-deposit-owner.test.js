import test from "node:test";
import assert from "node:assert/strict";
import { createCatalogDepositOwnerResolver } from "./catalog-deposit-owner.js";
import { requireUniqueDepositOwner } from "./deposit-owner-guard.js";
const tokenContract = "0x" + "a".repeat(40);
const depositAddress = "0x" + "b".repeat(40);
const evidence = { tokenContract, depositAddress, chainId: "56",
  eventKey: "bsc:56:0x" + "c".repeat(64) + ":0", ledgerAmount: "10.00000000" };
const row = { user_id: "123", wallet_address: depositAddress, active: true };
function mock(rows) {
  const calls = [];
  return { calls, async query(sql, params) {
    calls.push({sql, params});
    return { rows: sql.includes("current_setting(") ? [{marker:"active"}] : rows };
  }};
}
const resolve = createCatalogDepositOwnerResolver({tokenContract});
test("valid owner and lock before lookup", async () => {
  const client = mock([row]);
  const result = await resolve(client, evidence);
  assert.equal(requireUniqueDepositOwner(evidence, result).userId, "123");
  assert.match(client.calls[3].sql, /SHARE ROW EXCLUSIVE/);
  assert.deepEqual(client.calls[4].params, [depositAddress]);
});
test("reject unknown chain or token before database access", async () => {
  for (const change of [{chainId:"1"}, {tokenContract:depositAddress}, {depositAddress:"bad"}]) {
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
  let count = 0;
  const client = { async query(sql) { if (++count === 4) throw new Error("lock timeout"); return {rows: sql.includes("current_setting(") ? [{marker:"active"}] : []}; } };
  await assert.rejects(resolve(client,evidence), /lock timeout/);
  assert.equal(count,4);
});

test("reject invalid trusted token configuration", () => {
  for (const value of [undefined, "", "USDT", "0x123", null]) {
    assert.throws(() => createCatalogDepositOwnerResolver({tokenContract:value}), TypeError);
  }
});
test("normalize address and contract case while retaining owner attribution", async () => {
  const client = mock([{...row, wallet_address:depositAddress.toUpperCase().replace("0X","0x")}]);
  const upperEvidence = {...evidence, depositAddress:depositAddress.toUpperCase().replace("0X","0x"),
    tokenContract:tokenContract.toUpperCase().replace("0X","0x")};
  const owners = await resolve(client,upperEvidence);
  assert.equal(requireUniqueDepositOwner(upperEvidence,owners).userId,"123");
  assert.deepEqual(client.calls[4].params,[depositAddress]);
});
test("fail closed if transaction boundary is absent", async () => {
  const calls=[];
  const client={async query(sql){calls.push(sql);return {rows:sql.includes("current_setting(")?[{marker:""}]:[]};}};
  await assert.rejects(resolve(client,evidence), /Explicit database transaction required/);
  assert.equal(calls.length,2);
});
