import assert from "node:assert/strict";
import test from "node:test";

test("foreign and stale Back callbacks preserve the owner's active post edit", { skip: !process.env.DATABASE_URL }, async t => {
  const { registerPostManagement, clearPostManagementSession } = await import("./post-management.js");
  const { pool } = await import("./database.js");
  const owner = 8810232463;
  const routes = [];
  registerPostManagement({
    callbackQuery(pattern, handler) { routes.push({ pattern, handler }); },
    on() {}
  });
  const previews = new Map([["1", 101], ["2", 102]]);
  t.mock.method(pool, "query", async (sql, params) => {
    if (sql.includes("admin_preferences")) return { rows: [] };
    assert.match(sql, /SELECT id, title, content/);
    const [post, messageId, chatId] = params;
    const current = previews.get(post) === messageId && chatId === owner;
    return { rows: current ? [{ id: post, title: "Fixture", content: "Preview", scheduled_at: new Date(0),
      edit_version: 1, preview_message_id: messageId, preview_chat_id: chatId }] : [] };
  });
  async function click(action, post, messageId, sender = owner) {
    const data = action + ":" + post;
    const ctx = { from: { id: sender }, callbackQuery: { data,
      message: { message_id: messageId, chat: { type: "private", id: sender } } },
      async answerCallbackQuery() {}, async editMessageReplyMarkup() {}, async editMessageText() {}, async reply() {} };
    await routes.find(route => route.pattern.test(data)).handler(ctx);
  }
  t.after(() => clearPostManagementSession(owner));
  for (const [post, message, sender] of [[1, 101, 99], [1, 999, owner], [2, 102, owner]]) {
    await click("post_edit_title", 1, 101);
    await click("post_edit_back", post, message, sender);
    assert.equal(clearPostManagementSession(owner), true, "unrelated Back must preserve the edit");
  }
  await click("post_edit_title", 1, 101);
  await click("post_edit_back", 1, 101);
  assert.equal(clearPostManagementSession(owner), false);
});
