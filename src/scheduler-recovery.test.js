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
  await callback({
    from: { id: owner + 1 },
    callbackQuery: { data: "post_approve:42", message: { chat: { id: owner, type: "private" } } },
    async answerCallbackQuery(answer) { assert.equal(answer.text, "Unauthorized."); }
  });
  await callback({
    from: { id: owner },
    callbackQuery: { data: "post_approve:42", message: { chat: { id: owner, type: "private" } } },
    async answerCallbackQuery() { throw new Error("expired callback"); }
  });
  assert.equal(query.mock.callCount(), 0);
  assert.equal(connectCalls, 1);
  assert.equal(alerts.length, 2);
  assert.ok(alerts.every(alert => alert.show_alert && /recovering/.test(alert.text)));
  finishRecovery();
  assert.equal(await scheduler.ready, true);
  await scheduler.stop();
});

test("uncertain scheduler claim sessions are discarded without sending a preview", { timeout: 3000 }, async t => {
  for (const mode of ["begin-failure", "rollback-failure", "rolled-back-commit", "clean-rollback"]) {
    const { startScheduler } = await import("./scheduler.js?" + mode);
    const releases = [], queries = [];
    let sessions = 0, sends = 0;
    const connect = t.mock.method(pool, "connect", async () => {
      const session = ++sessions;
      return Object.assign(new EventEmitter(), {
        async query(sql) {
          if (session === 1) return { rows: sql.includes("AS unlocked") ? [{ unlocked: true }] : [] };
          queries.push(sql);
          if (sql === "BEGIN" && mode === "begin-failure") throw new Error("fixture begin failed");
          if (sql.includes("SKIP LOCKED")) {
            if (mode.includes("rollback") && mode !== "rolled-back-commit") throw new Error("fixture claim failed");
            return { rows: [{ id: "42" }] };
          }
          if (sql === "ROLLBACK" && mode === "rollback-failure") throw new Error("fixture rollback failed");
          if (sql === "COMMIT") return { command: "ROLLBACK" };
          if (sql.includes("AS unlocked")) return { rows: [{ unlocked: true }] };
          return { rows: [{ id: "42" }] };
        },
        release(discard) { releases.push({session,discard}); }
      });
    });
    const scheduler = startScheduler({ callbackQuery() {}, api: { sendMessage: async () => { sends++; } } });
    try {
      assert.equal(await scheduler.ready, true);
      await scheduler.stop();
      assert.equal(sends, 0);
      assert.deepEqual(releases, [{session:1,discard:false},{session:2,discard:mode!=="clean-rollback"}]);
      assert.equal(queries.some(sql => sql.includes("AS unlocked")), mode==="clean-rollback");
      assert.equal(queries.includes("ROLLBACK"), ["rollback-failure","clean-rollback"].includes(mode));
    } finally { await scheduler.stop(); connect.mock.restore(); }
  }
});
