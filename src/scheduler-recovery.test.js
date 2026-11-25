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
        return { command: sql.split(" ")[0], rows: sql.includes("AS unlocked") ? [{ unlocked: true }] : [] };
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
        return { command: sql.split(" ")[0], rows: sql.includes("AS unlocked") ? [{ unlocked: true }] : [] };
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
  for (const mode of ["begin-failure", "ambiguous-begin", "rollback-failure", "ambiguous-rollback", "rolled-back-commit", "ambiguous-commit", "clean-rollback"]) {
    const { startScheduler } = await import("./scheduler.js?" + mode);
    const releases = [], queries = [];
    let sessions = 0, sends = 0;
    const connect = t.mock.method(pool, "connect", async () => {
      const session = ++sessions;
      return Object.assign(new EventEmitter(), {
        async query(sql) {
          if (session === 1) return { command: sql.split(" ")[0], rows: sql.includes("AS unlocked") ? [{ unlocked: true }] : [] };
          queries.push(sql);
          if (sql === "BEGIN" && mode === "begin-failure") throw new Error("fixture begin failed");
          if (sql === "BEGIN") return {command: mode === "ambiguous-begin" ? undefined : "BEGIN"};
          if (sql.includes("SKIP LOCKED")) {
            if (mode.includes("rollback") && mode !== "rolled-back-commit") throw new Error("fixture claim failed");
            return { rows: [{ id: "42" }] };
          }
          if (sql === "ROLLBACK" && mode === "rollback-failure") throw new Error("fixture rollback failed");
          if (sql === "ROLLBACK") return mode === "ambiguous-rollback" ? {} : { command: "ROLLBACK" };
          if (sql === "COMMIT") return { command: mode === "ambiguous-commit" ? undefined : "ROLLBACK" };
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
      assert.equal(queries.includes("ROLLBACK"), ["rollback-failure","ambiguous-rollback","clean-rollback"].includes(mode));
      assert.equal(queries.some(sql=>sql.includes("SKIP LOCKED")), !["begin-failure","ambiguous-begin"].includes(mode));
    } finally { await scheduler.stop(); connect.mock.restore(); }
  }
});

test("scheduler shutdown drains both an in-flight claim and admitted callback, rejects new work", {timeout: 5000}, async t => {
  const {startScheduler}=await import("./scheduler.js?shutdown-drain");
  function gate(){let resolve;const promise=new Promise(done=>{resolve=done});return {promise,resolve};}
  const batchStarted=gate(),batchFinish=gate(),actionStarted=gate(),actionFinish=gate();
  let callback,sessions=0,claims=0,updates=0,edits=0;
  const released=[];
  t.mock.method(pool,"connect",async()=>{
    const session=++sessions;
    return Object.assign(new EventEmitter(),{
      async query(sql){
        if(sql.includes("AS unlocked"))return {rows:[{unlocked:true}]};
        if(sql.includes("SKIP LOCKED")){
          claims++;batchStarted.resolve();await batchFinish.promise;
          return {rows:[]};
        }
        return {command:sql.split(" ")[0],rows:[]};
      },
      release(discard){released.push({session,discard});}
    });
  });
  t.mock.method(pool,"query",async sql=>{
    if(sql.includes("SELECT ap.language"))return {rows:[{language:"en"}]};
    assert.match(sql,/SET status = 'rejected'/);
    updates++;actionStarted.resolve();await actionFinish.promise;
    return {rowCount:1};
  });
  const scheduler=startScheduler({callbackQuery(_pattern,fn){callback=fn;}});
  const admin=8810232463;
  const ctx={from:{id:admin},callbackQuery:{data:"post_reject:42",message:{message_id:9,chat:{id:admin,type:"private"}}},
    async answerCallbackQuery(){},async editMessageText(){edits++;}};
  let action,stopping;
  try{
    assert.equal(await scheduler.ready,true);
    await batchStarted.promise;
    action=callback(ctx);
    await actionStarted.promise;
    let drained=false;
    stopping=scheduler.stop().then(()=>{drained=true;});
    await new Promise(resolve=>setImmediate(resolve));
    assert.equal(drained,false);
    await callback(ctx);
    assert.equal(updates,1);
    assert.equal(claims,1);
    batchFinish.resolve();
    await new Promise(resolve=>setImmediate(resolve));
    assert.equal(drained,false);
    assert.deepEqual(released,[{session:1,discard:false},{session:2,discard:false}]);
    actionFinish.resolve();
    await Promise.all([action,stopping]);
    assert.equal(drained,true);
    assert.equal(edits,1);
    assert.equal(sessions,2);
  }finally{
    batchFinish.resolve();actionFinish.resolve();
    await Promise.allSettled([action,stopping,scheduler.stop()]);
  }
});

test("ready scheduler denies foreign or malformed callback chats before any lookup or publication", { timeout: 5000 }, async t => {
  const { startScheduler } = await import("./scheduler.js?ready-authorization");
  const owner = 8810232463;
  let callback, connections = 0, sends = 0;
  let batchFinished;
  const drainedBatch = new Promise(resolve => { batchFinished = resolve; });
  const queries = t.mock.method(pool, "query", async () => {
    throw new Error("Unauthorized callback must not query the database");
  });
  t.mock.method(pool, "connect", async () => {
    const session = ++connections;
    return Object.assign(new EventEmitter(), {
      async query(sql) {
        return { command: sql.split(" ")[0], rows: sql.includes("AS unlocked") ? [{ unlocked: true }] : [] };
      },
      release() { if (session === 2) batchFinished(); }
    });
  });
  const scheduler = startScheduler({
    callbackQuery(_pattern, fn) { callback = fn; },
    api: { async sendMessage() { sends++; } }
  });
  try {
    assert.equal(await scheduler.ready, true);
    await drainedBatch;
    for (const action of ["approve", "reject"]) {
      for (const [from, chat] of [
        [{ id: owner + 1 }, { id: owner, type: "private" }],
        [{ id: owner }, { id: owner, type: "group" }],
        [{ id: owner }, undefined],
        [{ id: owner }, { id: owner + 1, type: "private" }],
        [undefined, { id: owner, type: "private" }]
      ]) {
        const answers = [];
        await callback({
          from,
          callbackQuery: { data: "post_" + action + ":42", message: chat && { chat, message_id: 9 } },
          async answerCallbackQuery(answer) { answers.push(answer); }
        });
        assert.deepEqual(answers, [{ text: "Unauthorized.", show_alert: true }]);
      }
    }
    assert.equal(queries.mock.callCount(), 0);
    assert.equal(connections, 2);
    assert.equal(sends, 0);
  } finally { await scheduler.stop(); }
});
