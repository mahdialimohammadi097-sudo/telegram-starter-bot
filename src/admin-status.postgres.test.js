import assert from "node:assert/strict";
import test from "node:test";
import { Bot } from "grammy";

test("private status confirmations commit once with their audit row and survive delivery failures", {
  skip: !process.env.DATABASE_URL
}, async t => {
  const { pool } = await import("./database.js");
  const { registerAdminOps } = await import("./admin-ops.js");
  const client = await pool.connect();
  const owner = 8810232463;
  const target = 450021;
  let leased = false;
  try {
    await client.query(`
      SET search_path TO pg_temp;
      CREATE TEMP TABLE users (id bigint PRIMARY KEY, telegram_id bigint, status text, username text,
        first_name text, last_name text, referral_code text, created_at timestamptz);
      CREATE TEMP TABLE admin_users (user_id bigint, role text, status text);
      CREATE TEMP TABLE admin_preferences (user_id bigint, language text);
      CREATE TEMP TABLE admin_audit_logs (id bigserial PRIMARY KEY, created_at timestamptz DEFAULT now(), admin_user_id bigint, actor_telegram_id bigint, action text,
        target_user_id bigint, currency text, metadata jsonb, details jsonb);
      INSERT INTO admin_users VALUES (1, 'owner', 'active');
      INSERT INTO admin_preferences VALUES (1, 'fa')
    `);
    await client.query("INSERT INTO users VALUES (1, $1, 'active'), (2, $2, 'active')", [owner, target]);
    t.mock.method(pool, "query", client.query.bind(client));
    t.mock.method(pool, "connect", async () => {
      assert.equal(leased, false);
      leased = true;
      return { query: client.query.bind(client), release() { leased = false; } };
    });
    const bot = new Bot("offline", { botInfo: { id: 7, is_bot: true, first_name: "Test", username: "offline_bot" } });
    registerAdminOps(bot);
    const calls = [];
    let failAck = false;
    let failEdit = false;
    bot.api.config.use(async (_prev, method, payload) => {
      assert.equal(leased, false, "release transaction connection before Telegram requests");
      calls.push({ method, payload });
      if ((failAck && method === "answerCallbackQuery") || (failEdit && method === "editMessageText")) {
        return { ok: false, error_code: 400, description: "synthetic delivery failure" };
      }
      return { ok: true, result: true };
    });
    let seq = 0;
    async function click(data, sender = owner, type = "private") {
      calls.length = 0;
      const from = { id: sender, first_name: "Fixture", is_bot: false };
      await bot.handleUpdate({ update_id: ++seq, callback_query: { id: String(seq), data, from, chat_instance: "offline",
        message: { message_id: 1, date: 0, chat: { type, id: type === "private" ? sender : -7 } } } });
      return calls.map(call => call.method);
    }
    const status = async () => (await client.query("SELECT status FROM users WHERE id = 2")).rows[0].status;
    const audit = async () => (await client.query("SELECT actor_telegram_id, target_user_id, action, details FROM admin_audit_logs")).rows;
    failEdit = true;
    assert.deepEqual(await click("admin_user_action:" + target + ":blocked:1"), ["answerCallbackQuery", "editMessageText", "sendMessage"]);
    const prompt = calls.at(-1).payload;
    assert.match(prompt.text, /وضعیت جدید: مسدود/);
    const confirm = prompt.reply_markup.inline_keyboard.flat().find(b => b.text === "تأیید").callback_data;
    failEdit = false;
    for (const [sender, type] of [[target, "private"], [owner, "group"]]) {
      assert.deepEqual(await click(confirm, sender, type), ["answerCallbackQuery"]);
      assert.equal(calls[0].payload.text, "Unauthorized.");
    }
    assert.equal(await status(), "active");
    assert.deepEqual(await audit(), []);
    failAck = true;
    assert.deepEqual(await click(confirm), ["answerCallbackQuery", "editMessageText"]);
    assert.match(calls.at(-1).payload.text, /وضعیت: مسدود/);
    assert.ok(calls.at(-1).payload.reply_markup.inline_keyboard.flat().some(b => b.callback_data === "admin_users:1"));
    failAck = false;
    assert.deepEqual(await click(confirm), ["answerCallbackQuery", "editMessageText"]);
    assert.match(calls[0].payload.text, /منقضی/);
    assert.equal(calls[0].payload.show_alert, true);
    assert.match(calls[1].payload.text, /وضعیت: مسدود/);
    assert.ok(calls[1].payload.reply_markup.inline_keyboard.flat().some(b => b.callback_data === "admin_users:1"));
    assert.equal(await status(), "blocked");
    assert.deepEqual(await audit(), [{ actor_telegram_id: String(owner), target_user_id: "2", action: "user_blocked",
      details: { old_status: "active", new_status: "blocked" } }]);

    await client.query("ALTER TABLE admin_audit_logs ADD CHECK (action <> 'user_activated')");
    await click("admin_user_confirm:" + target + ":active:blocked");
    assert.match(calls[0].payload.text, /منقضی/);
    await click("admin_user_action:" + target + ":active");
    const activate = calls.at(-1).payload.reply_markup.inline_keyboard.flat().find(b => b.text === "تأیید").callback_data;
    await click(activate);
    assert.match(calls[0].payload.text, /به‌روزرسانی وضعیت کاربر ممکن نشد/);
    assert.equal(await status(), "blocked");
    assert.equal((await audit()).length, 1);

    await client.query(`INSERT INTO admin_audit_logs (action)
      SELECT 'archive_' || i FROM generate_series(2, 12) i`);
    assert.deepEqual(await click("admin_logs"), ["answerCallbackQuery", "sendMessage"]);
    const latest = calls.at(-1).payload;
    assert.match(latest.text, /ARCHIVE_12/);
    assert.doesNotMatch(latest.text, /ARCHIVE_2\b/);
    const older = latest.reply_markup.inline_keyboard.flat().find(b => b.text === "فعالیت‌های قدیمی‌تر").callback_data;
    await client.query("INSERT INTO admin_audit_logs (action) VALUES ('admin_user_search')");
    for (const [sender, type] of [[target, "private"], [owner, "group"]]) {
      assert.deepEqual(await click(older, sender, type), ["answerCallbackQuery"]);
      assert.equal(calls[0].payload.text, "Unauthorized.");
    }
    assert.deepEqual(await click(older), ["answerCallbackQuery", "editMessageText"]);
    const archive = calls.at(-1).payload;
    assert.match(archive.text, /ARCHIVE_2\b/);
    assert.match(archive.text, /کاربر تعلیق شد.*450021.*فعال → مسدود/);
    assert.doesNotMatch(archive.text, /ARCHIVE_3\b/);
    const newest = archive.reply_markup.inline_keyboard.flat().find(b => b.text === "آخرین فعالیت‌ها").callback_data;
    await client.query("UPDATE admin_preferences SET language = 'en'");
    await click(newest);
    assert.match(calls.at(-1).payload.text, /User search/);
    await click(older);
    assert.match(calls.at(-1).payload.text, /User suspended.*ACTIVE → BLOCKED/);
    const button = label => calls.at(-1).payload.reply_markup.inline_keyboard.flat().find(b => b.text === label).callback_data;
    const filter = button("User status changes");
    await client.query("INSERT INTO admin_audit_logs (action) SELECT 'user_blocked' FROM generate_series(1, 10)");
    await click(filter);
    assert.equal(calls.at(-1).payload.text.match(/User suspended/g).length, 10);
    assert.doesNotMatch(calls.at(-1).payload.text, /ARCHIVE|User search/);
    const olderChanges = button("Older activity");
    for (const [sender, type] of [[target, "private"], [owner, "group"]]) {
      assert.deepEqual(await click(olderChanges, sender, type), ["answerCallbackQuery"]);
      assert.equal(calls[0].payload.text, "Unauthorized.");
    }
    await client.query("UPDATE admin_preferences SET language = 'fa'");
    await click(olderChanges);
    assert.match(calls.at(-1).payload.text, /فعال → مسدود/);
    assert.doesNotMatch(calls.at(-1).payload.text, /ARCHIVE/);
    await click(button("آخرین فعالیت‌ها"));
    assert.match(calls.at(-1).payload.text, /پروفینو — تغییرات وضعیت کاربران/);
    await click(button("همه فعالیت‌ها"));
    assert.match(calls.at(-1).payload.text, /پروفینو — گزارش فعالیت مدیر/);

    await click("admin_user:" + target + ":1");
    const history = button("سابقه وضعیت");
    await client.query("UPDATE admin_audit_logs SET target_user_id = 2 WHERE target_user_id IS NULL AND action = 'user_blocked'");
    await client.query("INSERT INTO admin_audit_logs (action, target_user_id) VALUES ('user_blocked', 1)");
    await click(history);
    assert.equal(calls.at(-1).payload.text.match(/کاربر تعلیق شد/g).length, 10);
    assert.ok(!calls.at(-1).payload.text.includes(String(owner)));
    const nextUserPage = button("فعالیت‌های قدیمی‌تر");
    assert.deepEqual(await click(nextUserPage, target), ["answerCallbackQuery"]);
    assert.equal(calls[0].payload.text, "Unauthorized.");
    await click(nextUserPage);
    assert.match(calls.at(-1).payload.text, /فعال → مسدود/);
    await click(button("جزئیات کاربر"));
    assert.equal(button("کاربران"), "admin_users:1");
    await client.query("UPDATE admin_preferences SET language = 'en'");
    await client.query("UPDATE users SET status = 'active' WHERE id = 2");
    const beforeReplay = (await audit()).length;
    await click(confirm);
    assert.match(calls[0].payload.text, /outdated/);
    assert.equal(await status(), "active");
    assert.equal((await audit()).length, beforeReplay);
    await client.query("DELETE FROM users WHERE id = 2");
    failEdit = true;
    assert.deepEqual(await click(confirm), ["answerCallbackQuery", "editMessageText", "sendMessage"]);
    assert.match(calls[0].payload.text, /outdated/);
    assert.equal(calls.at(-1).payload.text, "User not found.");
    assert.equal(button("Users"), "admin_users:1");
    failEdit = false;
    await click("au:999999:0");
    assert.match(calls.at(-1).payload.text, /No user status changes recorded yet/);
  } finally {
    client.release(true);
    await pool.end();
  }
});
