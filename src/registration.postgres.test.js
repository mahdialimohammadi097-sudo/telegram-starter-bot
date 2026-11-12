import assert from "node:assert/strict";
import test from "node:test";
import { Bot } from "grammy";

test("Telegram registration preserves identity and invite codes across repeated deep links", {
  skip: !process.env.DATABASE_URL
}, async t => {
  const { pool } = await import("./database.js");
  const { registerCommands } = await import("./commands.js");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`CREATE TEMP TABLE users (
      id bigserial PRIMARY KEY, telegram_id bigint UNIQUE NOT NULL, username text,
      first_name text, last_name text, referral_code text UNIQUE, status text,
      created_at timestamptz DEFAULT now()
    ) ON COMMIT DROP`);
    await client.query("SET LOCAL search_path TO pg_temp");
    t.mock.method(pool, "query", client.query.bind(client));
    const bot = new Bot("offline", { botInfo: { id: 700, is_bot: true, first_name: "Test", username: "PROFINO1bot" } });
    registerCommands(bot);
    const replies = [];
    bot.api.config.use(async (_prev, method, payload) => {
      assert.equal(method, "sendMessage");
      replies.push(payload);
      return { ok: true, result: true };
    });
    let sequence = 0;
    async function send(id, text, name = "Guest") {
      replies.length = 0;
      const message = { message_id: ++sequence, date: 0, text, from: { id, first_name: name, is_bot: false },
        chat: { id, type: "private" } };
      if (text.startsWith("/")) message.entities = [{ type: "bot_command", offset: 0, length: text.split(" ")[0].length }];
      await bot.handleUpdate({ update_id: sequence, message });
      assert.equal(replies.length, 1);
      assert.equal(replies[0].chat_id, id);
      return replies[0].text;
    }
    assert.match(await send(8001, "/start"), /Your account is ready/);
    const menu = replies[0].reply_markup.keyboard;
    assert.match(await send(8001, "Support"), /Transaction History/);
    assert.equal(replies[0].reply_markup.keyboard[0][0].text, "⬅ Main Menu");
    assert.equal(await send(8001, "⬅ Main Menu"), "Main Menu");
    assert.deepEqual(replies[0].reply_markup.keyboard, menu);
    for (const input of ["/help", "Where is my wallet?"]) {
      await send(8001, input);
      assert.deepEqual(replies[0].reply_markup.keyboard, menu);
    }
    const invitation = await send(8001, "Referral Program");
    const [, payload] = invitation.match(/https:\/\/t\.me\/PROFINO1bot\?start=(ref_[0-9a-f]{16})/);
    assert.match(await send(8002, "/start " + payload), /Your account is ready/);
    const account = async id => (await client.query(
      "SELECT id, referral_code, first_name FROM users WHERE telegram_id = $1", [id]
    )).rows[0];
    const original = await account(8002);
    assert.notEqual(original.referral_code, payload.slice(4));
    await send(8002, "/start " + payload, "Updated");
    assert.deepEqual(await account(8002), { ...original, first_name: "Updated" });
    await send(8002, "/start ref_" + original.referral_code, "Updated");
    assert.deepEqual(await account(8002), { ...original, first_name: "Updated" });
    assert.equal((await client.query("SELECT count(*)::int AS n FROM users")).rows[0].n, 2);
    await client.query("UPDATE users SET referral_code = NULL WHERE telegram_id = 8002");
    assert.ok((await send(8002, "My Account")).includes("Referral Code: Send /start"));
    assert.match(await send(8002, "Referral Program"), /Send \/start to generate/);
    await send(8002, "/start");
    const repaired = await account(8002);
    assert.match(repaired.referral_code, /^[0-9a-f]{16}$/);
    assert.equal(repaired.id, original.id);
    assert.ok((await send(8002, "Referral Program")).includes("ref_" + repaired.referral_code));
    await client.query("UPDATE users SET status = 'blocked' WHERE telegram_id = 8002");
    assert.match(await send(8002, "/start", "Blocked update"), /account is not active/);
    assert.deepEqual(await account(8002), repaired);
  } finally {
    await client.query("ROLLBACK");
    client.release();
    await pool.end();
  }
});
