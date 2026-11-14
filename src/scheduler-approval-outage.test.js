import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

process.env.DATABASE_URL ??= "postgresql://localhost/profino_test";
const { pool } = await import("./database.js");

for (const failure of ["connect", "lock"]) {
  test("approval alerts the admin when PostgreSQL fails at " + failure, async t => {
    const { startScheduler } = await import("./scheduler.js?" + failure);
    const calls = [];
    let unavailable = false;
    t.mock.method(pool, "query", async () => ({ rows: [{ language: "fa" }] }));
    t.mock.method(pool, "connect", async () => {
      if (unavailable && failure === "connect") throw new Error("offline");
      return Object.assign(new EventEmitter(), {
        async query(sql) {
          if (unavailable) {
            calls.push(sql);
            if (sql.includes("pg_advisory_lock_shared")) throw new Error("lock unavailable");
          }
          return { rows: sql.includes("AS unlocked") ? [{ unlocked: !unavailable }] : [] };
        },
        release() {}
      });
    });
    let approve;
    const scheduler = startScheduler({ callbackQuery(pattern, handler) { approve = handler; } });
    t.after(() => scheduler.stop());
    await scheduler.ready;
    await new Promise(resolve => setImmediate(resolve));
    unavailable = true;
    const admin = 8810232463;
    const alerts = [];
    const send = t.mock.fn();
    await approve({
      from: { id: admin },
      callbackQuery: { data: "post_approve:42", message: { chat: { id: admin }, message_id: 27 } },
      api: { sendMessage: send },
      async answerCallbackQuery(answer) { alerts.push(answer); }
    });
    assert.equal(alerts.length, 1);
    assert.equal(alerts[0].show_alert, true);
    assert.match(alerts[0].text, /دوباره/);
    assert.equal(send.mock.callCount(), 0);
    assert.ok(calls.every(sql => !sql.includes("UPDATE")));
  });
}
