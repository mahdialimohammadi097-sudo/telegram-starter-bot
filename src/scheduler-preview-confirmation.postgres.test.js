import assert from "node:assert/strict";
import test from "node:test";
import pg from "pg";

test("an unconfirmed preview is held for review across a scheduler restart", {
  skip: !process.env.DATABASE_URL
}, async t => {
  const { pool } = await import("./database.js");
  // One PostgreSQL session keeps all fixtures isolated in temporary tables.
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  t.after(() => client.end());
  await client.query(`
    CREATE TEMP TABLE scheduled_posts (
      id bigint PRIMARY KEY, title text, content text, scheduled_at timestamptz, updated_at timestamptz,
      status text, preview_message_id bigint, preview_chat_id bigint, approved_by bigint
    );
    CREATE TEMP TABLE users (id bigint, telegram_id bigint);
    CREATE TEMP TABLE admin_preferences (user_id bigint, language text);
    CREATE FUNCTION pg_temp.skip_preview_confirmation() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.status = 'preview_sent' THEN RETURN NULL; END IF;
        RETURN NEW;
      END $$;
    CREATE TRIGGER skip_confirmation BEFORE UPDATE ON scheduled_posts
      FOR EACH ROW EXECUTE FUNCTION pg_temp.skip_preview_confirmation();
    INSERT INTO scheduled_posts (id,title,content,scheduled_at,status)
      VALUES (1,'Preview','Example',now(),'scheduled');
  `);
  t.mock.method(pool, "connect", async () => ({
    query: client.query.bind(client), on: client.on.bind(client), off: client.off.bind(client), release() {}
  }));
  t.mock.method(pool, "query", client.query.bind(client));
  const owner = 8810232463;
  const recipients = [];
  const bot = {
    callbackQuery() {},
    api: { async sendMessage(id) {
      recipients.push(id);
      return { message_id: 42, chat: { id } };
    } }
  };
  async function runBatch(instance) {
    const { startScheduler } = await import("./scheduler.js?" + instance);
    const scheduler = startScheduler(bot);
    try {
      assert.equal(await scheduler.ready, true);
    } finally {
      await scheduler.stop();
    }
  }

  await runBatch("first");
  const status = async () => (await client.query("SELECT status FROM scheduled_posts")).rows[0].status;
  assert.equal(await status(), "preview_unknown");
  assert.deepEqual(recipients, [owner]);

  await runBatch("restart");
  assert.equal(await status(), "preview_unknown");
  assert.deepEqual(recipients, [owner]);
});
