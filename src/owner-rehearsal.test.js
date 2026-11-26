import { test } from "node:test";
import assert from "node:assert/strict";
import { registerOwnerRehearsal } from "./owner-rehearsal.js";

function setup({ name = "profino_test", marker = "isolated-staging", databaseMarker = true, configured = true, tlsMode = "disable", testUrl = "postgresql://localhost/profino_test", reservation = { id: "12", amount: "1", status: "reserved" }, closeError = false, idleError = false, cancelError = false, snapshots = [{ AVAILABLE: "5" }, { AVAILABLE: "4", WITHDRAWAL_HOLD: "1" }, { AVAILABLE: "5" }] } = {}) {
  let reads = 0;
  const calls = [];
  let handler;
  let idleListener;
  const replyStates = [];
  const poolConfigs = [];
  const sandbox = {
    on(event, fn) { assert.equal(event, "error"); idleListener = fn; },
    async query(sql) {
      calls.push("sandbox-read");
      return { rows: sql.includes("current_database") ? [{ database_name: name, environment: marker, database_marker: databaseMarker }] : [{ id: "9" }] };
    },
    async end() {
      calls.push("closed");
      if (idleError) idleListener(new Error("private fixture idle error"));
      if (closeError) throw new Error("private fixture close error");
    }
  };
  registerOwnerRehearsal({ command(name, fn) { assert.equal(name, "admintest"); handler = fn; } }, {
    productionPool: { async query() { calls.push("production-read"); return { rows: [{ name: "profino-db" }] }; } },
    ownerId: 10, getLanguage: async () => "fa",
    env: configured ? { PROFINO_TEST_DATABASE_URL: testUrl, PROFINO_TEST_DATABASE_NAME: "profino_test", PROFINO_TEST_DB_TLS_MODE: tlsMode } : {},
    createPool: config => { poolConfigs.push(config); return sandbox; },
    balances: async pool => { assert.equal(pool, sandbox); const snapshot = snapshots[reads++]; if(snapshot instanceof Error)throw snapshot; return snapshot; },
    reserve: async (pool, id, key, amount) => {
      assert.equal(pool, sandbox); assert.equal(id, "9"); assert.equal(key, "owner-rehearsal:32");
      assert.equal(amount, "1"); calls.push("reserve"); return reservation;
    },
    cancel: async pool => { assert.equal(pool, sandbox); calls.push("cancel"); if (cancelError) throw new Error("private fixture cancellation error"); }
  });
  const messages = [];
  const ctx = { from: { id: 10 }, chat: { id: 10, type: "private" }, message: { message_id: 32 },
    reply: async text => { replyStates.push(calls.at(-1)); messages.push(text); } };
  return { handler, ctx, calls, messages, replyStates, poolConfigs };
}
test("same-bot owner rehearsal routes its writes exclusively to the isolated database", async () => {
  const s = setup();
  await s.handler(s.ctx);
  assert.deepEqual(s.calls, ["production-read", "sandbox-read", "sandbox-read", "reserve", "cancel", "closed"]);
  assert.match(s.messages[0], /موفق/);
});
test("ordinary users and group chats cannot access the owner rehearsal", async () => {
  const s = setup();
  await s.handler({ ...s.ctx, from: { id: 11 } });
  await s.handler({ ...s.ctx, chat: { type: "group", id: 10 } });
  await s.handler({ ...s.ctx, chat: { type: "private", id: 11 } });
  assert.deepEqual(s.calls, []);
  assert.deepEqual(s.messages, []);
});
test("production database, missing isolation marker and absent configuration fail before writes", async () => {
  for (const config of [{ name: "profino-db" }, { marker: null }, { databaseMarker: false }, { databaseMarker: "true" }, { testUrl: "postgresql://localhost/profino_test?sslmode=require" }, { configured: false }]) {
    const s = setup(config);
    await s.handler(s.ctx);
    assert.ok(!s.calls.includes("reserve"));
    assert.ok(!s.calls.includes("cancel"));
    assert.equal(s.messages.length, 1);
  }
});

test("exact reconciliation accepts PostgreSQL decimal zero padding", async () => {
  const s = setup({ snapshots: [
    { AVAILABLE: "5.000000000000000000" },
    { AVAILABLE: "4.000000000000000000", WITHDRAWAL_HOLD: "1.000000000000000000" }, { AVAILABLE: "5.0", WITHDRAWAL_HOLD: "0.000000000000000000" }
  ] });
  await s.handler(s.ctx);
  assert.match(s.messages[0], /موفق/);
  assert.ok(s.calls.includes("cancel"));
});

test("nonrepresentable starting balances fail before any synthetic writes", async () => {
  for (const snapshot of [{ AVAILABLE: "5.000000001" }, { AVAILABLE: "5", WITHDRAWAL_HOLD: null }, { AVAILABLE: "-1" }]) {
    const s = setup({ snapshots: [snapshot] });
    await s.handler(s.ctx);
    assert.ok(!s.calls.includes("reserve"));
    assert.ok(!s.calls.includes("cancel"));
    assert.match(s.messages[0], /کامل نشد/);
  }
});

test("reconciliation cannot hide small changes behind display rounding", async () => {
  for (const snapshot of [{ AVAILABLE: "5.000000001" }, { AVAILABLE: "5", WITHDRAWAL_HOLD: "0.000000001" }, { AVAILABLE: "5.00000001" }]) {
    const s = setup({ snapshots: [{ AVAILABLE: "5" }, { AVAILABLE: "4", WITHDRAWAL_HOLD: "1" }, snapshot] });
    await s.handler(s.ctx);
    assert.ok(s.calls.includes("cancel"));
    assert.match(s.messages[0], /کامل نشد/);
  }
});

test("owner rehearsal requires exact intermediate reservation movement and rejects cancelled replay",async()=>{
  for(const config of [
    {snapshots:[{AVAILABLE:"5"},{AVAILABLE:"5"},{AVAILABLE:"5"}]},
    {snapshots:[{AVAILABLE:"5"},{AVAILABLE:"4",WITHDRAWAL_HOLD:"0.9"},{AVAILABLE:"5"}]},
    {snapshots:[{AVAILABLE:"5"},new Error("fixture read failed")]},
    {reservation:{id:"12",amount:"2",status:"reserved"}},
    {reservation:{id:"12",amount:"1",status:"cancelled"}}
  ]){
    const s=setup(config);
    await s.handler(s.ctx);
    assert.match(s.messages[0],/کامل نشد/);
    assert.ok(s.calls.includes("reserve"));
    assert.equal(s.calls.includes("cancel"),config.reservation?.status!=="cancelled");
    assert.equal(s.calls.at(-1),"closed");
  }
  const s=setup({snapshots:[{AVAILABLE:"5",WITHDRAWAL_HOLD:"2"},{AVAILABLE:"4",WITHDRAWAL_HOLD:"3"},{AVAILABLE:"5",WITHDRAWAL_HOLD:"2"}]});
  await s.handler(s.ctx);
  assert.match(s.messages[0],/موفق/);
});

test("owner rehearsal publishes success only after isolated connection cleanup",async()=>{
  const clean=setup();
  await clean.handler(clean.ctx);
  assert.match(clean.messages[0],/موفق/);
  assert.deepEqual(clean.replyStates,["closed"]);
  for(const config of [{closeError:true},{idleError:true},{cancelError:true}]){
    const s=setup(config);
    await s.handler(s.ctx);
    assert.equal(s.messages.length,1);
    assert.match(s.messages[0],/کامل نشد/);
    assert.deepEqual(s.replyStates,["closed"]);
    assert.ok(s.calls.includes("cancel"));
    // A failed cleanup must not permanently lock the command.
    await s.handler(s.ctx);
    assert.equal(s.calls.filter(call=>call==="production-read").length,2);
    assert.doesNotMatch(s.messages[1],/در حال اجراست/);
  }
});

test("owner rehearsal requires explicit independent test TLS policy before any database connection", async () => {
  for (const tlsMode of [null, "", "require", "verify-ca", "prefer"]) {
    const s = setup({ tlsMode });
    await s.handler(s.ctx);
    assert.deepEqual(s.calls, []);
    assert.deepEqual(s.poolConfigs, []);
    assert.match(s.messages[0], /TLS/);
  }
  for (const tlsMode of ["verify-full", "disable"]) {
    const s = setup({ tlsMode });
    await s.handler(s.ctx);
    assert.match(s.messages[0], /موفق/);
    assert.equal(s.poolConfigs.length, 1);
    assert.deepEqual(s.poolConfigs[0].ssl, tlsMode === "disable" ? false : { rejectUnauthorized: true });
  }
});
