import assert from "node:assert/strict";
import test from "node:test";
import { Bot } from "grammy";

test("private admin language survives new updates and handles unavailable preferences or Telegram edits", {
  skip: !process.env.DATABASE_URL
}, async t => {
  const { pool } = await import("./database.js");
  const { registerCommands } = await import("./commands.js");
  const client = await pool.connect();
  const admin = 8810232463;
  try {
    await client.query("BEGIN");
    await client.query(`
      CREATE TEMP TABLE users (id bigint PRIMARY KEY, telegram_id bigint UNIQUE, status text);
      CREATE TEMP TABLE admin_preferences (user_id bigint PRIMARY KEY, language text, updated_at timestamptz);
      CREATE TEMP TABLE scheduled_posts (
        id bigserial PRIMARY KEY, title varchar(255), content text, scheduled_at timestamptz, status text
      );
      SET LOCAL search_path TO pg_temp
    `);
    await client.query("INSERT INTO users VALUES (1, $1, 'active')", [admin]);
    const query = t.mock.method(pool, "query", client.query.bind(client));
    const logs = t.mock.method(console, "error", () => {});
    const bot = new Bot("offline", { botInfo: { id: 7, is_bot: true, first_name: "Test", username: "offline_bot" } });
    registerCommands(bot);
    let calls = [];
    let editError;
    let canPost = true;
    bot.api.config.use(async (_prev, method, payload) => {
      calls.push({ method, payload });
      if (method === "getChat") return { ok: true, result: { id: -700 } };
      if (method === "getMe") return { ok: true, result: { id: 7 } };
      if (method === "getChatMember") return { ok: true, result: { status: "administrator", can_post_messages: canPost } };
      if (method === "editMessageText" && editError) {
        return { ok: false, error_code: 400, description: editError };
      }
      return { ok: true, result: true };
    });
    let sequence = 0;
    async function update(text, sender = admin, type = "private", plainText = false) {
      calls = [];
      const from = { id: sender, is_bot: false, first_name: "Fixture" };
      const message = { message_id: ++sequence, date: 0, from, chat: { type, id: type === "private" ? sender : -7 } };
      if (plainText || text.startsWith("/")) {
        message.text = text;
        if (!plainText) message.entities = [{ type: "bot_command", offset: 0, length: text.split(" ")[0].length }];
        await bot.handleUpdate({ update_id: sequence, message });
      } else {
        await bot.handleUpdate({ update_id: sequence, callback_query: {
          id: String(sequence), from, message, data: text, chat_instance: "offline"
        } });
      }
      return calls.map(call => call.method);
    }
    await update("/adminlanguage");
    assert.match(calls[0].payload.text, /ADMIN PANEL LANGUAGE/);
    assert.deepEqual(await update("admin_language_set:fa"), ["answerCallbackQuery", "editMessageText"]);
    assert.match(calls[1].payload.text, /تنظیم زبان پنل مدیریت/);
    await update("/planpreview SMART 25");
    assert.match(calls[0].payload.text, /مبلغ خالص تسویه: 27\.36/);

    await update("/help");
    assert.match(calls[0].payload.text, /دستورهای مدیریت/);
    assert.match(calls[0].payload.text, /\/planpreview/);
    await update("/help", 99);
    assert.equal(calls[0].payload.text, "Use the menu buttons to navigate PROFINO.");
    await update("/channelcheck");
    assert.match(calls.at(-1).payload.text, /مجوز انتشار پست تأیید شد/);
    canPost = false;
    await update("/channelcheck");
    assert.match(calls.at(-1).payload.text, /مجوز انتشار پست تأیید نشده/);
    assert.deepEqual(await update("/channelcheck", 99), ["sendMessage"]);
    assert.equal(calls[0].payload.text, "Access denied.");

    const draftText = text => update(text, admin, "private", true);
    await update("/newpost");
    assert.match(calls[0].payload.text, /مرحله ۱/);
    await draftText("Quarterly update");
    assert.match(calls[0].payload.text, /مرحله ۲/);
    await draftText("Service update for subscribers.");
    assert.match(calls[0].payload.text, /مرحله ۳/);
    await draftText("invalid");
    assert.match(calls[0].payload.text, /معتبر نیست/);
    await draftText("۲۰۹۹-۰۶-۱۵ ۱۲:۳۰");
    assert.match(calls[0].payload.text, /پست زمان‌بندی شد/);
    const { rows: [post] } = await client.query("SELECT title, content, scheduled_at, status FROM scheduled_posts");
    assert.equal(post.title, "Quarterly update");
    assert.equal(post.content, "Service update for subscribers.");
    assert.equal(post.scheduled_at.toISOString(), "2099-06-15T12:30:00.000Z");
    assert.equal(post.status, "scheduled");
    await client.query(`INSERT INTO scheduled_posts (title, scheduled_at, status)
      SELECT repeat('x', 250) || i, now(), 'scheduled' FROM generate_series(1,19) i`);
    await update("/scheduledposts");
    assert.ok(calls.length > 1);
    assert.ok(calls.every(call => call.method === "sendMessage" && call.payload.chat_id === admin &&
      call.payload.text.startsWith("پست‌های زمان‌بندی‌شده") && call.payload.text.length <= 4096));
    assert.equal(calls.map(call => call.payload.text).join("").match(/شناسه: /g).length, 20);
    await update("/newpost");
    await update("/cancelpost");
    assert.match(calls[0].payload.text, /لغو شد/);
    editError = "Bad Request: message is not modified";
    assert.deepEqual(await update("admin_language_set:fa"), ["answerCallbackQuery", "editMessageText"]);
    editError = "Bad Request: message can't be edited";
    assert.deepEqual(await update("admin_language_set:en"), ["answerCallbackQuery", "editMessageText", "sendMessage"]);
    assert.match(calls[2].payload.text, /ADMIN PANEL LANGUAGE/);
    const preference = () => client.query("SELECT language FROM admin_preferences WHERE user_id = 1");
    assert.equal((await preference()).rows[0].language, "en");
    await update("admin_language_set:fa", 99);
    assert.equal(calls[0].payload.text, "Unauthorized.");
    await update("admin_language_set:fa", admin, "group");
    assert.match(calls[0].payload.text, /private chat/);
    assert.equal((await preference()).rows[0].language, "en");

    query.mock.mockImplementation(async () => {
      throw Object.assign(new Error("private diagnostic text"), { code: "08006" });
    });
    await update("/adminlanguage");
    assert.match(calls[0].payload.text, /ADMIN PANEL LANGUAGE/);
    assert.deepEqual(await update("admin_language_set:fa"), ["answerCallbackQuery"]);
    assert.equal(calls[0].payload.show_alert, true);
    assert.match(calls[0].payload.text, /ذخیره تنظیم زبان ممکن نشد/);
    const diagnostics = JSON.stringify(logs.mock.calls.map(call => call.arguments));
    assert.match(diagnostics, /08006/);
    assert.doesNotMatch(diagnostics, /private diagnostic text/);
  } finally {
    await client.query("ROLLBACK");
    client.release();
    await pool.end();
  }
});
