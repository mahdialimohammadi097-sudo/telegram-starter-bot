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
      CREATE TEMP TABLE users (id bigint PRIMARY KEY, telegram_id bigint UNIQUE, status text, username text, first_name text,
        last_name text, referral_code text, created_at timestamptz);
      CREATE TEMP TABLE admin_users (user_id bigint, role text, status text);
      CREATE TEMP TABLE admin_audit_logs (id bigserial PRIMARY KEY, created_at timestamptz DEFAULT now(),
        admin_user_id bigint, actor_telegram_id bigint, action text, target_user_id bigint,
        currency text, metadata jsonb, details jsonb);
      CREATE TEMP TABLE admin_preferences (user_id bigint PRIMARY KEY, language text, updated_at timestamptz);
      CREATE TEMP TABLE scheduled_posts (
        id bigserial PRIMARY KEY, title varchar(255), content text, scheduled_at timestamptz, updated_at timestamptz DEFAULT now(), status text,
        created_at timestamptz DEFAULT now(), published_at timestamptz, cancelled_at timestamptz,
        cancellation_reason text, published_message_id bigint
      );
      CREATE TEMP TABLE scheduled_post_history (
        post_id bigint, event_type text, old_status text, new_status text, details jsonb, changed_at timestamptz DEFAULT now()
      );
      SET LOCAL search_path TO pg_temp
    `);
    await client.query("INSERT INTO users VALUES (1, $1, 'active')", [admin]);
    await client.query("INSERT INTO users (id, telegram_id, username, status) VALUES (2, 123456, 'qa_user', 'blocked'), (3, 654321, 'qaXuser', 'active')");
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
    const startTime = Date.now();
    // Model a human-paced interaction without sleeping or disabling the limiter.
    t.mock.method(Date, "now", () => startTime + sequence * 1000);
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

    await update("/usersearch @QA_USER");
    assert.match(calls[0].payload.text, /@qa_user \| مسدود/);
    assert.doesNotMatch(calls[0].payload.text, /qaXuser/);
    const button = calls[0].payload.reply_markup.inline_keyboard[0][0];
    assert.equal(button.callback_data, "admin_user:123456");
    assert.deepEqual(await update(button.callback_data), ["answerCallbackQuery", "editMessageText"]);
    assert.match(calls[1].payload.text, /وضعیت: مسدود/);
    await update("/usersearch %");
    assert.equal(calls[0].payload.text, "کاربر منطبقی پیدا نشد.");
    await update("/usersearch @");
    assert.match(calls[0].payload.text, /روش استفاده/);
    await update("/usersearch qa", 99);
    assert.equal(calls[0].payload.text, "Access denied.");

    await client.query(`INSERT INTO users (id, telegram_id, status, created_at)
      SELECT i, 800000 + i, 'active', now() FROM generate_series(10, 17) i`);
    await update("admin_users:0");
    assert.match(calls.at(-1).payload.text, /نمایش 1 تا 8 از 11/);
    const nextUsers = calls.at(-1).payload.reply_markup.inline_keyboard.flat()
      .find(button => button.text === "بعدی →").callback_data;
    await update(nextUsers);
    assert.match(calls.at(-1).payload.text, /نمایش 9 تا 11 از 11/);
    const keyboardData = () => calls.at(-1).payload.reply_markup.inline_keyboard.flat().map(button => button.callback_data);
    const detailFromList = keyboardData().find(data => data.startsWith("admin_user:"));
    assert.match(detailFromList, /^admin_user:\d+:1$/);
    await update(detailFromList);
    assert.ok(keyboardData().includes(nextUsers));
    const action = keyboardData().find(data => data.startsWith("admin_user_action:"));
    await update(action);
    assert.ok(keyboardData().includes(detailFromList));
    const confirmStatus = keyboardData().find(data => data.startsWith("usc:"));
    assert.deepEqual(confirmStatus.split(":").slice(1, 4), [action.split(":")[1], "blocked", "active"]);
    assert.match(confirmStatus, /:\d+:1$/);
    await update(detailFromList);
    await update(keyboardData().find(data => data === nextUsers));
    assert.match(calls.at(-1).payload.text, /نمایش 9 تا 11 از 11/);
    await client.query("DELETE FROM users WHERE id BETWEEN 10 AND 17");
    await update(detailFromList);
    assert.equal(calls.at(-1).payload.text, "کاربر پیدا نشد.");
    assert.ok(keyboardData().includes(nextUsers));
    editError = "Bad Request: message can't be edited";
    assert.deepEqual(await update(nextUsers), ["answerCallbackQuery", "editMessageText", "sendMessage"]);
    assert.match(calls.at(-1).payload.text, /نمایش 1 تا 3 از 3/);
    assert.ok(!calls.at(-1).payload.reply_markup.inline_keyboard.flat()
      .some(button => button.callback_data.startsWith("admin_users:")));
    editError = "Bad Request: message is not modified";
    assert.deepEqual(await update("admin_users:99999999999999999999"), ["answerCallbackQuery", "editMessageText"]);
    editError = undefined;

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
    const buttons = () => calls.at(-1).payload.reply_markup.inline_keyboard.flat();
    await update("admin_posts");
    assert.match(calls.at(-1).payload.text, /زمان‌بندی‌شده: 20/);
    const history = buttons().find(button => button.text === "تاریخچه انتشار").callback_data;
    assert.deepEqual(await update(history), ["answerCallbackQuery", "editMessageText"]);
    assert.match(calls.at(-1).payload.text, /تاریخچه پست‌ها/);
    const uncertain = buttons().find(button => button.text === "انتشارهای نامشخص").callback_data;
    await client.query("UPDATE scheduled_posts SET status='publish_unknown' WHERE id=1");
    await update(uncertain);
    const review = buttons().find(button => button.callback_data.startsWith("posthist_detail:")).callback_data;
    await update(review);
    const reviewText = () => calls.find(call => call.method === "editMessageText").payload.text;
    assert.match(reviewText(), /تطبیق دهید/);
    assert.match(reviewText(), /@PROFINO1/);
    assert.doesNotMatch(reviewText(), /شناسه پیام کانال:/);
    assert.equal(calls[0].payload.reply_markup.inline_keyboard.flat()[0].callback_data, "posthist_page:publish_unknown:0");
    await client.query("UPDATE scheduled_posts SET published_message_id=910 WHERE id=1");
    await client.query("UPDATE admin_preferences SET language='en'");
    await update(review);
    assert.match(reviewText(), /Channel message ID: 910/);
    assert.match(reviewText(), /Check @PROFINO1/);
    assert.equal((await client.query("SELECT status FROM scheduled_posts WHERE id=1")).rows[0].status, "publish_unknown");
    await client.query("UPDATE admin_preferences SET language='fa'");
    await client.query("UPDATE scheduled_posts SET status='preview_unknown' WHERE id=2");
    await update(history);
    const previewFilter = buttons().find(button => button.text === "پیش‌نمایش‌های نامشخص").callback_data;
    await update(previewFilter);
    const previewRows = buttons().filter(button => button.callback_data.startsWith("posthist_detail:"));
    assert.deepEqual(previewRows.map(button => button.callback_data), ["posthist_detail:2:preview_unknown:0"]);
    await update(previewRows[0].callback_data);
    assert.match(reviewText(), /گفت‌وگوی خصوصی با ربات/);
    const previewBack = calls[0].payload.reply_markup.inline_keyboard.flat()[0].callback_data;
    assert.equal(previewBack, "posthist_page:preview_unknown:0");
    await client.query("UPDATE admin_preferences SET language='en'");
    await update(previewBack);
    assert.ok(buttons().some(button => button.text === "Uncertain previews"));
    await update(previewRows[0].callback_data);
    assert.match(reviewText(), /private chat with the bot/);
    assert.equal((await client.query("SELECT status FROM scheduled_posts WHERE id=2")).rows[0].status, "preview_unknown");
    await client.query("UPDATE admin_preferences SET language='fa'");
    await update("posthist_filter:published");
    assert.equal(buttons().find(button => button.text === "همه پست‌ها").callback_data, "posthist_filter:all");
    await client.query("UPDATE scheduled_posts SET status = 'failed'");
    await update("/posthistory failed");
    const next = buttons().find(button => button.callback_data === "posthist_page:failed:1");
    assert.deepEqual(await update(next.callback_data), ["answerCallbackQuery", "editMessageText"]);
    assert.match(calls.at(-1).payload.text, /9–16/);
    const detail = buttons().find(button => button.callback_data.startsWith("posthist_detail:")).callback_data;
    const postId = detail.split(":")[1];
    const content = "🌱".repeat(1750);
    await client.query("UPDATE scheduled_posts SET content = $2 WHERE id = $1", [postId, content]);
    await client.query(`INSERT INTO scheduled_post_history (post_id, event_type, old_status, new_status)
      SELECT $1, 'status_changed', 'scheduled', 'failed' FROM generate_series(1, 10)`, [postId]);
    assert.deepEqual(await update(detail), ["editMessageText", "sendMessage", "answerCallbackQuery"]);
    const parts = calls.slice(0, 2).map(call => call.payload.text);
    assert.ok(parts.every(part => part.length <= 4096 && part.isWellFormed()));
    assert.ok(parts.join("").includes(content));
    assert.match(parts.join(""), /زمان‌بندی‌شده → ناموفق/);
    const back = calls[1].payload.reply_markup.inline_keyboard[0][0].callback_data;
    assert.equal(back, "posthist_page:failed:1");
    await update(back);
    assert.match(calls.at(-1).payload.text, /9–16/);
    // The filtered list shrinks while the admin is reading a detail on page two.
    await client.query("UPDATE scheduled_posts SET status='scheduled' WHERE id <> $1", [postId]);
    await update(back);
    assert.match(calls.at(-1).payload.text, /نمایش 1–1 از 1/);
    assert.ok(buttons().some(button => button.callback_data === "posthist_detail:" + postId + ":failed:0"));
    assert.ok(buttons().every(button => !button.callback_data.startsWith("posthist_page:")));
    await update("posthist_detail:" + postId);
    assert.equal(calls[1].payload.reply_markup.inline_keyboard[0][0].callback_data, "posthist_filter:all");
    assert.deepEqual(await update(history, admin, "group"), ["answerCallbackQuery"]);
    assert.equal(calls[0].payload.text, "Please use the bot in a private chat.");
    assert.deepEqual(await update(history, 99), ["answerCallbackQuery"]);
    assert.equal(calls[0].payload.text, "Unauthorized.");
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
