import assert from "node:assert/strict";
import test from "node:test";

process.env.DATABASE_URL ??= "postgresql://localhost/profino_test";
const { pool } = await import("./database.js");
const { registerPostHistory, clearPostHistorySession } = await import("./post-history.js");

test("only the current restore prompt may confirm or cancel the proposed time", async t => {
  const owner = 8810232463;
  t.after(() => clearPostHistorySession(owner));
  const writes = [];
  t.mock.method(pool, "query", async (sql, args) => {
    if (sql.includes("admin_preferences")) return { rows: [] };
    if (sql.startsWith("SELECT id, status")) return { rowCount: 1, rows: [{ status: "rejected" }] };
    assert.match(sql, /^UPDATE scheduled_posts/);
    writes.push(args);
    return { rowCount: 1, rows: [{ title: "Draft", scheduled_at: args[0] }] };
  });
  const callbacks = [];
  let input;
  registerPostHistory({
    command() {},
    callbackQuery(pattern, handler) { callbacks.push([pattern, handler]); },
    on(_event, handler) { input = handler; }
  });
  let nextId = 100;
  const answers = [];
  const ctx = {
    from: { id: owner }, chat: { id: owner, type: "private" },
    async answerCallbackQuery(answer) { answers.push(answer); },
    async reply() { return { message_id: ++nextId }; },
    async editMessageText() {}
  };
  async function click(data, messageId) {
    const [, handler] = callbacks.find(([pattern]) => pattern.test(data));
    await handler({ ...ctx, callbackQuery: { data, message: { message_id: messageId } } });
  }
  async function propose(date) {
    await click("posthist_restore:1", 10);
    await input({ ...ctx, message: { text: date } });
    return nextId;
  }
  const oldPrompt = await propose("2090-01-01 12:00");
  const currentPrompt = await propose("2090-02-01 13:00");
  for (const action of ["confirm", "cancel"]) {
    await click("posthist_restore_" + action + ":1", oldPrompt);
    assert.equal(answers.at(-1).show_alert, true);
    assert.deepEqual(writes, []);
  }
  await click("posthist_restore_confirm:1", currentPrompt);
  assert.deepEqual(writes, [["2090-02-01T13:00:00.000Z", "1"]]);
  const cancelPrompt = await propose("2090-03-01 12:00");
  await click("posthist_restore_cancel:1", cancelPrompt);
  await click("posthist_restore_confirm:1", cancelPrompt);
  assert.equal(answers.at(-1).show_alert, true);
  assert.equal(writes.length, 1);

  const expiredPrompt = await propose("2090-04-01 12:00");
  t.mock.method(Date, "now", () => Date.parse("2090-04-01T12:00:00Z"));
  await click("posthist_restore_confirm:1", expiredPrompt);
  assert.equal(writes.length, 1);
  assert.match(answers.at(-1).text, /future time/);
  await input({ ...ctx, message: { text: "2090-04-01 12:30" } });
  const replacementPrompt = nextId;
  await click("posthist_restore_confirm:1", expiredPrompt);
  assert.equal(writes.length, 1);
  await click("posthist_restore_confirm:1", replacementPrompt);
  assert.deepEqual(writes.at(-1), ["2090-04-01T12:30:00.000Z", "1"]);
});
