import assert from "node:assert/strict";
import test from "node:test";

process.env.DATABASE_URL ??= "postgresql://localhost/profino_test";
const { pool } = await import("./database.js");
const { startScheduler } = await import("./scheduler.js");

test("an expired rejection acknowledgement still clears the preview buttons", async t => {
  t.mock.method(pool, "connect", async () => { throw new Error("scheduler offline"); });
  let updates = 0;
  t.mock.method(pool, "query", async sql => {
    if (sql.includes("SELECT ap.language")) return { rows: [{ language: "fa" }] };
    assert.match(sql, /SET status = 'rejected'/);
    updates++;
    return { rowCount: 1 };
  });
  let onAction;
  const scheduler = startScheduler({ callbackQuery(pattern, handler) { onAction = handler; } });
  t.after(() => scheduler.stop());
  const admin = 8810232463;
  const answers = [];
  const edits = [];
  await onAction({
    from: { id: admin },
    callbackQuery: { data: "post_reject:42", message: { message_id: 9, chat: { id: admin } } },
    async answerCallbackQuery(answer) {
      answers.push(answer.text);
      throw new Error("expired callback");
    },
    async editMessageText(text, options) { edits.push([text, options]); }
  });
  assert.equal(updates, 1);
  assert.deepEqual(answers, ["پست رد شد."]);
  assert.deepEqual(edits, [["پروفینو — پست 42 رد شد.", { reply_markup: { inline_keyboard: [] } }]]);
});
