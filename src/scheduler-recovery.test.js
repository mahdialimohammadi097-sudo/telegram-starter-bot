import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
process.env.DATABASE_URL ??= "postgresql://localhost/profino_test";
const { pool } = await import("./database.js");

test("a temporary recovery outage retries before claiming scheduled posts", { timeout: 3000 }, async t => {
  const { startScheduler } = await import("./scheduler.js?retry");
  const operations = [];
  let attempts = 0;
  t.mock.method(pool, "connect", async () => {
    if (++attempts === 1) throw new Error("temporary outage");
    return Object.assign(new EventEmitter(), {
      async query(sql) {
        if (sql.includes("preview_unknown")) operations.push("recover");
        if (sql.includes("SKIP LOCKED")) operations.push("claim");
        return { rows: sql.includes("AS unlocked") ? [{ unlocked: true }] : [] };
      },
      release() {}
    });
  });
  const scheduler = startScheduler({ callbackQuery() {} }, { recoveryRetryMs: 1 });
  t.after(() => scheduler.stop());
  assert.equal(await scheduler.ready, true);
  await scheduler.stop();
  assert.deepEqual(operations, ["recover", "claim"]);
});

test("shutdown cancels a pending startup retry", { timeout: 3000 }, async t => {
  const { startScheduler } = await import("./scheduler.js?stop");
  const connect = t.mock.method(pool, "connect", async () => { throw new Error("offline"); });
  const scheduler = startScheduler({ callbackQuery() {} });
  await new Promise(resolve => setImmediate(resolve));
  await scheduler.stop();
  assert.equal(await scheduler.ready, false);
  assert.equal(connect.mock.callCount(), 1);
});

test("approval and rejection cannot run before startup recovery completes", { timeout: 3000 }, async t => {
  const { startScheduler } = await import("./scheduler.js?recovery-gate");
  let finishRecovery;
  const blocked = new Promise(resolve => { finishRecovery = resolve; });
  let connectCalls = 0, callback;
  const query = t.mock.method(pool, "query", async () => { throw new Error("unexpected callback database access"); });
  t.mock.method(pool, "connect", async () => {
    connectCalls++;
    return Object.assign(new EventEmitter(), {
      async query(sql) {
        if (sql.includes("preview_unknown")) await blocked;
        return { rows: sql.includes("AS unlocked") ? [{ unlocked: true }] : [] };
      },
      release() {}
    });
  });
  const scheduler = startScheduler({ callbackQuery(_pattern, fn) { callback = fn; } });
  t.after(async () => { finishRecovery(); await scheduler.stop(); });
  const owner = 8810232463;
  const alerts = [];
  for (const action of ["approve", "reject"]) {
    await callback({
      from: { id: owner },
      callbackQuery: { data: "post_" + action + ":42", message: { chat: { id: owner, type: "private" }, message_id: 9 } },
      async answerCallbackQuery(answer) { alerts.push(answer); }
    });
  }
  assert.equal(query.mock.callCount(), 0);
  assert.equal(connectCalls, 1);
  assert.equal(alerts.length, 2);
  assert.ok(alerts.every(alert => alert.show_alert && /recovering/.test(alert.text)));
  finishRecovery();
  assert.equal(await scheduler.ready, true);
  await scheduler.stop();
});
