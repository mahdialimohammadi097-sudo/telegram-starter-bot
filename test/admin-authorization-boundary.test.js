import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

for (const [file, registration, expected] of [
  ["post-management.js", "registerPostManagement", 8],
  ["post-history.js", "registerPostHistory", 8],
  ["admin-ops.js", "registerAdminOps", 24]
]) {
  test(file + " rejects unauthorized commands and callbacks before database access", async () => {
    const source = readFileSync(new URL("../src/" + file, import.meta.url), "utf8")
      .replace(/^import .*;$/gm, "")
      .replace(/const (ADMIN_ID|SUPER_ADMIN_ID) = \d+;/g, "const $1 = 123;")
      .replace(/export (async function|function)/g, "$1");
    const handlers = [];
    let queries = 0;
    const rejectQuery = async () => { queries++; throw new Error("unexpected database access"); };
    const register = vm.runInNewContext(source + "\n" + registration, {
      pool: { query: rejectQuery, connect: rejectQuery }, getAdminLanguage: rejectQuery
    });
    register({
      callbackQuery: (_pattern, fn) => handlers.push(fn),
      command: (_pattern, fn) => handlers.push(fn),
      on() {}
    }, { inspectTestQueue: rejectQuery, testWithdrawalReview: { list: rejectQuery, inspect: rejectQuery, release: rejectQuery } });
    assert.equal(handlers.length, expected);
    for (const handler of handlers) {
      for (const [actor, chat] of [
        [456, { id: 456, type: "private" }],
        [123, { id: 456, type: "private" }],
        [123, { id: 123, type: "group" }]
      ]) {
        const responses = [];
        await handler({
          from: { id: actor }, chat, match: "",
          callbackQuery: { data: "fixture:1", message: { chat } },
          answerCallbackQuery: async value => responses.push(value.text),
          reply: async value => responses.push(value)
        });
        assert.equal(responses.length, 1);
        assert.match(responses[0], /Unauthorized|Access denied/);
      }
    }
    assert.equal(queries, 0);
  });
}
