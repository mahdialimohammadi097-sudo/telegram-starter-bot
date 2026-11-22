import { test } from "node:test";
import assert from "node:assert/strict";
import { registerOwnerRehearsal } from "./owner-rehearsal.js";

function setup({ name = "profino_test", marker = "isolated-staging", configured = true } = {}) {
  const calls = [];
  let handler;
  const sandbox = {
    async query(sql) {
      calls.push("sandbox-read");
      return { rows: sql.includes("current_database") ? [{ name, marker }] : [{ id: "9" }] };
    },
    async end() { calls.push("closed"); }
  };
  registerOwnerRehearsal({ command(name, fn) { assert.equal(name, "admintest"); handler = fn; } }, {
    productionPool: { async query() { calls.push("production-read"); return { rows: [{ name: "profino-db" }] }; } },
    ownerId: 10, getLanguage: async () => "fa",
    env: configured ? { PROFINO_TEST_DATABASE_URL: "unused", PROFINO_TEST_DATABASE_NAME: "profino_test" } : {},
    createPool: () => sandbox,
    balances: async pool => { assert.equal(pool, sandbox); return { AVAILABLE: "5" }; },
    reserve: async (pool, id, key, amount) => {
      assert.equal(pool, sandbox); assert.equal(id, "9"); assert.equal(key, "owner-rehearsal:32");
      assert.equal(amount, "1"); calls.push("reserve"); return { id: "12" };
    },
    cancel: async pool => { assert.equal(pool, sandbox); calls.push("cancel"); }
  });
  const messages = [];
  const ctx = { from: { id: 10 }, chat: { id: 10, type: "private" }, message: { message_id: 32 },
    reply: async text => messages.push(text) };
  return { handler, ctx, calls, messages };
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
  for (const config of [{ name: "profino-db" }, { marker: null }, { configured: false }]) {
    const s = setup(config);
    await s.handler(s.ctx);
    assert.ok(!s.calls.includes("reserve"));
    assert.ok(!s.calls.includes("cancel"));
    assert.equal(s.messages.length, 1);
  }
});
