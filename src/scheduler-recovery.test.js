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
