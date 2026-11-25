import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFileSync } from "node:fs";
import { isPrivateSimulationChat } from "./simulation-chat-safety.js";

const source = readFileSync(new URL("./commands.js", import.meta.url), "utf8");
const start = source.indexOf("  bot.use(async (ctx, next) => {");
const end = source.indexOf("\n  });", start);
assert.ok(start >= 0 && end > start);

function setup(status = "active") {
  let handler;
  let rateChecks = 0, databaseChecks = 0, forwarded = 0;
  const bot = { use(fn) { handler = fn; } };
  vm.runInNewContext(source.slice(start, end + 5), {
    bot, isPrivateSimulationChat, ADMIN_ID: 123,
    rateLimiter: { consume() { rateChecks++; return { allowed: true }; } },
    pool: { async query() { databaseChecks++; return { rowCount: 1, rows: [{ status }] }; } },
    safeDiagnosticCode: () => "UNAVAILABLE", console: { error() {} }
  });
  return {
    async run(actor, chat, callback = false) {
      const replies = [];
      await handler({ from: { id: actor }, chat,
        ...(callback ? { callbackQuery: {} } : {}),
        answerCallbackQuery: async x => replies.push(x.text),
        reply: async x => replies.push(x)
      }, async () => { forwarded++; });
      return replies;
    },
    counts: () => [rateChecks, databaseChecks, forwarded]
  };
}

test("global bot middleware denies mismatched and invalid identities before rate limit or database access", async () => {
  const s = setup();
  for (const [id, chat] of [
    [123, { id: 456, type: "private" }],
    [456, { id: 123, type: "private" }],
    [123, { id: 123, type: "group" }],
    [0, { id: 0, type: "private" }],
    ["123", { id: "123", type: "private" }]
  ]) {
    const replies = await s.run(id, chat, true);
    assert.match(replies[0], /private chat/);
  }
  assert.deepEqual(s.counts(), [0, 0, 0]);
});

test("matching private identities preserve owner exemption and ordinary user status checks", async () => {
  const s = setup();
  await s.run(123, { id: 123, type: "private" });
  await s.run(456, { id: 456, type: "private" });
  assert.deepEqual(s.counts(), [2, 1, 2]);
  const blocked = setup("blocked");
  assert.match((await blocked.run(456, { id: 456, type: "private" }))[0], /not active/);
  assert.deepEqual(blocked.counts(), [1, 1, 0]);
});
