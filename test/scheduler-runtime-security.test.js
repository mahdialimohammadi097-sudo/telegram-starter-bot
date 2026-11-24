import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const source = readFileSync(new URL("../src/scheduler.js", import.meta.url), "utf8");
function extract(start, end, name, context) {
  const body = source.slice(source.indexOf(start), source.indexOf(end));
  return vm.runInNewContext(body + "\n" + name, context);
}

test("unauthorized scheduler callbacks are rejected before any language or database lookup", async () => {
  let lookups = 0;
  const handle = extract("async function handlePostAction(", "export function startScheduler(", "handlePostAction", {
    ADMIN_ID: 123,
    getAdminLanguage: async () => { lookups++; throw new Error("must not run"); }
  });
  for (const [from, chat] of [[456, { id: 123, type: "private" }], [123, { id: 123, type: "group" }], [123, undefined], [123, { id: 456, type: "private" }]]) {
    const answers = [];
    await handle({ from: { id: from }, callbackQuery: { message: { chat }, data: "post_approve:1" }, answerCallbackQuery: async answer => answers.push(answer) });
    assert.equal(answers.length, 1);
    assert.equal(answers[0].text, "Unauthorized.");
  }
  assert.equal(lookups, 0);
});

test("failed scheduler rollback discards the connection and preserves the original failure", async () => {
  const original = new Error("synthetic query failure");
  let releaseError, releaseCount = 0;
  const client = {
    async query(sql) {
      if (sql === "BEGIN") return;
      if (sql === "ROLLBACK") throw new Error("synthetic rollback failure");
      throw original;
    },
    release(error) { releaseCount++; releaseError = error; }
  };
  const claim = extract("async function claimScheduledPosts(", "async function sendPreview(", "claimScheduledPosts", {
    pool: { connect: async () => client }, BATCH_SIZE: 5
  });
  await assert.rejects(claim(), error => error === original);
  assert.equal(releaseCount, 1);
  assert.equal(releaseError?.message, "scheduler_rollback_failed");
});
