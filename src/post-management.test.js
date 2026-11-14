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

test("Persian post edits keep the administrator's language through saving and stale buttons", {
  skip: !process.env.DATABASE_URL
}, async t => {
  const { Bot } = await import("grammy");
  const { registerPostManagement } = await import("./post-management.js");
  const { pool } = await import("./database.js");
  const owner = 8810232463;
  let current = true;
  t.mock.method(pool, "query", async (sql, params) => {
    if (sql.includes("admin_preferences")) return { rows: [{ language: "fa" }] };
    if (sql.startsWith("SELECT id, title")) return { rows: current ? [{
      id: "1", preview_chat_id: owner, preview_message_id: 10, edit_version: 1
    }] : [] };
    assert.match(sql, /UPDATE scheduled_posts SET content/);
    assert.equal(params[0], "English channel copy");
    current = false;
    return { rowCount: 1, rows: [{ id: "1", scheduled_at: new Date("2030-04-05T10:00:00Z") }] };
  });
  const bot = new Bot("offline", { botInfo: { id: 7, is_bot: true, first_name: "Test", username: "fixture_bot" } });
  registerPostManagement(bot);
  const messages = [];
  bot.api.config.use(async (_prev, method, payload) => {
    if (payload.text) messages.push(payload.text);
    return { ok: true, result: true };
  });
  const from = { id: owner, is_bot: false, first_name: "Test" };
  const message = { chat: { id: owner, type: "private" }, message_id: 10, date: 0, from };
  let update = 0;
  const click = data => bot.handleUpdate({ update_id: ++update, callback_query: {
    id: String(update), from, message, data, chat_instance: "fixture"
  } });
  await click("post_edit_title:1");
  assert.match(messages.at(-1), /عنوان جدید/);
  await click("post_edit_content:1");
  assert.match(messages.at(-1), /متن جدید/);
  await bot.handleUpdate({ update_id: ++update, message: { ...message, message_id: 11, text: "English channel copy" } });
  assert.match(messages.at(-2), /پیش‌نمایش.*اعتبار ندارد/);
  assert.match(messages.at(-1), /زمان‌بندی.*UTC/s);
  assert.match(messages.at(-1), /تأیید شما/);
  await click("post_edit_content:1");
  assert.match(messages.at(-1), /پیش‌نمایش دیگر معتبر نیست/);
});
