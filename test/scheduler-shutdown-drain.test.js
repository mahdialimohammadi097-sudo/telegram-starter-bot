import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { setImmediate as nextTurn, setTimeout as delay } from "node:timers/promises";

const schedulerSource = readFileSync(new URL("../src/scheduler.js", import.meta.url), "utf8");
const runtimeSource = readFileSync(new URL("../index.js", import.meta.url), "utf8");

function gate() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}
function setup({ recover = async () => {}, retryDelay = delay } = {}) {
  const batch = gate(), action = gate();
  let callback, batchCalls = 0, actionCalls = 0;
  const startBatch = schedulerSource.slice(schedulerSource.indexOf("function startBatch("), schedulerSource.indexOf("async function updateAdminMessage("));
  const startScheduler = schedulerSource.slice(schedulerSource.indexOf("export function startScheduler(")).replace("export function", "function");
  const start = vm.runInNewContext("let activeBatch = null, isStarted = false, schedulerStopped = false, schedulerTimer = null;\n" +
    startBatch + startScheduler + "\nstartScheduler", {
    recoverInterruptedOperations: recover, AbortController, delay: retryDelay,
    processScheduledPosts: async () => { batchCalls++; await batch.promise; },
    handlePostAction: async () => { actionCalls++; await action.promise; },
    console: { log() {}, error() {} }, CHECK_INTERVAL_MS: 15000,
    setInterval: () => ({ unref() {} }), clearInterval: () => {}
  });
  const scheduler = start({ callbackQuery: (_pattern, fn) => { callback = fn; } });
  return { scheduler, batch, action, invoke: () => callback({}), counts: () => [batchCalls, actionCalls] };
}

test("scheduler shutdown waits for active batch and approval action", async () => {
  const s = setup();
  await s.scheduler.ready;
  const active = s.invoke();
  let drained = false;
  const stopping = s.scheduler.stop().then(() => { drained = true; });
  await nextTurn();
  assert.equal(drained, false);
  await s.invoke();
  assert.deepEqual(s.counts(), [1, 1]);
  s.batch.resolve();
  await nextTurn();
  assert.equal(drained, false);
  s.action.resolve();
  await Promise.all([active, stopping]);
  assert.equal(drained, true);
});

test("runtime waits for scheduler drain before closing database", () => {
  const shutdown = runtimeSource.slice(runtimeSource.indexOf("async function shutdown("), runtimeSource.indexOf("registerCommands(bot);"));
  assert.match(shutdown, /const schedulerDrained = scheduler\?\.stop\(\)/);
  assert.match(shutdown, /await Promise\.all\(\[closeHttpServer\(\), schedulerDrained\]\);[\s\S]*await closeDatabase\(\)/);
});

test("scheduler retries recovery and refuses callbacks until recovery succeeds", async () => {
  let attempts = 0;
  const waiting = gate(), retry = gate();
  const s = setup({
    recover: async () => { if (++attempts === 1) throw new Error("synthetic outage"); },
    retryDelay: async () => { waiting.resolve(); await retry.promise; }
  });
  await waiting.promise;
  await s.invoke();
  assert.deepEqual(s.counts(), [0, 0]);
  retry.resolve();
  assert.equal(await s.scheduler.ready, true);
  assert.equal(attempts, 2);
  const active = s.invoke();
  assert.deepEqual(s.counts(), [1, 1]);
  s.batch.resolve();
  s.action.resolve();
  await Promise.all([active, s.scheduler.stop()]);
});

test("stopping during recovery cancels the retry delay", async () => {
  const waiting = gate();
  const s = setup({
    recover: async () => { throw new Error("synthetic outage"); },
    retryDelay: (ms, value, options) => {
      waiting.resolve();
      return delay(ms, value, options);
    }
  });
  await waiting.promise;
  await s.scheduler.stop();
  assert.equal(await s.scheduler.ready, false);
  assert.deepEqual(s.counts(), [0, 0]);
});
