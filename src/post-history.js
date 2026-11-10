import { InlineKeyboard } from "grammy";
import { pool } from "./database.js";

const ADMIN_ID = 8810232463;
const PAGE_SIZE = 8;
const restoreSessions = new Map();

function isAdminPrivate(ctx) {
  return ctx.from?.id === ADMIN_ID && ctx.chat?.type === "private";
}

function parseUtcDateTime(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})$/.exec(value);
  if (!match) return null;
  const [year, month, day, hour, minute] = match.slice(1).map(Number);
  if (year < 2000 || month < 1 || month > 12 || hour > 23 || minute > 59) return null;
  const date = new Date(Date.UTC(year, month - 1, day, hour, minute));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 ||
      date.getUTCDate() !== day || date.getUTCHours() !== hour ||
      date.getUTCMinutes() !== minute || date.getTime() <= Date.now() + 60000) return null;
  return date;
}

function formatUtc(value) {
  return new Date(value).toLocaleString("en-GB", {
    timeZone: "UTC", dateStyle: "medium", timeStyle: "short"
  }) + " UTC";
}

export async function ensurePostHistorySchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS scheduled_post_history (
      id BIGSERIAL PRIMARY KEY,
      post_id BIGINT NOT NULL REFERENCES scheduled_posts(id) ON DELETE CASCADE,
      event_type VARCHAR(40) NOT NULL,
      old_status VARCHAR(40),
      new_status VARCHAR(40),
      details JSONB NOT NULL DEFAULT '{}'::jsonb,
      changed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_scheduled_post_history_post
    ON scheduled_post_history(post_id, changed_at DESC)
  `);

  await pool.query(`
    CREATE OR REPLACE FUNCTION profino_log_scheduled_post_history()
    RETURNS TRIGGER AS $$
    DECLARE
      event_name VARCHAR(40);
      event_details JSONB := '{}'::jsonb;
    BEGIN
      IF TG_OP = 'INSERT' THEN
        event_name := 'created';
        event_details := jsonb_build_object('title', NEW.title, 'scheduled_at', NEW.scheduled_at);
        INSERT INTO scheduled_post_history(post_id, event_type, new_status, details)
        VALUES (NEW.id, event_name, NEW.status, event_details);
        RETURN NEW;
      END IF;

      IF OLD.status IS DISTINCT FROM NEW.status THEN
        event_name := 'status_changed';
        event_details := jsonb_build_object('title', NEW.title);
      ELSIF OLD.scheduled_at IS DISTINCT FROM NEW.scheduled_at THEN
        event_name := 'rescheduled';
        event_details := jsonb_build_object('old_scheduled_at', OLD.scheduled_at, 'new_scheduled_at', NEW.scheduled_at);
      ELSIF OLD.title IS DISTINCT FROM NEW.title OR OLD.content IS DISTINCT FROM NEW.content THEN
        event_name := 'content_edited';
        event_details := jsonb_build_object('title_changed', OLD.title IS DISTINCT FROM NEW.title,
                                            'content_changed', OLD.content IS DISTINCT FROM NEW.content);
      ELSE
        RETURN NEW;
      END IF;

      INSERT INTO scheduled_post_history(post_id, event_type, old_status, new_status, details)
      VALUES (NEW.id, event_name, OLD.status, NEW.status, event_details);
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql
  `);

  await pool.query(`
    DROP TRIGGER IF EXISTS trg_scheduled_post_history ON scheduled_posts;
    CREATE TRIGGER trg_scheduled_post_history
    AFTER INSERT OR UPDATE ON scheduled_posts
    FOR EACH ROW EXECUTE FUNCTION profino_log_scheduled_post_history()
  `);

  // Seed a one-time snapshot so posts created before history tracking remain discoverable.
  await pool.query(`
    INSERT INTO scheduled_post_history(post_id, event_type, new_status, details)
    SELECT p.id, 'tracking_started', p.status,
           jsonb_build_object('title', p.title, 'scheduled_at', p.scheduled_at)
    FROM scheduled_posts p
    WHERE NOT EXISTS (
      SELECT 1 FROM scheduled_post_history h WHERE h.post_id = p.id
    )
  `);
}

async function showHistory(ctx, page = 0) {
  const offset = page * PAGE_SIZE;
  const result = await pool.query(
    `SELECT id, title, scheduled_at, status, updated_at
     FROM scheduled_posts
     ORDER BY updated_at DESC, id DESC
     LIMIT $1 OFFSET $2`,
    [PAGE_SIZE, offset]
  );
  const count = await pool.query("SELECT COUNT(*)::int AS total FROM scheduled_posts");
  const total = count.rows[0].total;
  if (!total) return ctx.reply("No posts have been created yet.");

  const keyboard = new InlineKeyboard();
  for (const post of result.rows) {
    keyboard.text("#" + post.id + " · " + post.status.toUpperCase(), "posthist_detail:" + post.id).row();
  }
  if (page > 0) keyboard.text("← Previous", "posthist_page:" + (page - 1));
  if (offset + result.rowCount < total) keyboard.text("Next →", "posthist_page:" + (page + 1));
  const body = result.rows.map(post =>
    "#" + post.id + " — " + post.title + "\n" +
    "Status: " + post.status.toUpperCase() + "\n" +
    "Scheduled: " + formatUtc(post.scheduled_at)
  ).join("\n\n");
  await ctx.reply(
    "PROFINO — POST HISTORY\n\n" + body +
    "\n\nShowing " + (offset + 1) + "–" + (offset + result.rowCount) + " of " + total,
    { reply_markup: keyboard }
  );
}

async function showDetails(ctx, postId, edit = false) {
  const result = await pool.query(
    "SELECT id, title, content, scheduled_at, status, created_at, updated_at, published_at, cancelled_at, cancellation_reason, published_message_id FROM scheduled_posts WHERE id = $1",
    [postId]
  );
  if (!result.rowCount) {
    await ctx.answerCallbackQuery({ text: "Post not found.", show_alert: true });
    return;
  }
  const post = result.rows[0];
  const history = await pool.query(
    "SELECT event_type, old_status, new_status, details, changed_at FROM scheduled_post_history WHERE post_id = $1 ORDER BY changed_at DESC LIMIT 10",
    [postId]
  );
  const historyText = history.rows.map(item =>
    formatUtc(item.changed_at) + " — " + item.event_type.toUpperCase() +
    (item.old_status || item.new_status ? " (" + (item.old_status || "—") + " → " + (item.new_status || "—") + ")" : "")
  ).join("\n");
  const text = [
    "PROFINO — POST #" + post.id,
    "",
    "Title: " + post.title,
    "Status: " + post.status.toUpperCase(),
    "Scheduled: " + formatUtc(post.scheduled_at),
    "Created: " + formatUtc(post.created_at),
    "Updated: " + formatUtc(post.updated_at),
    post.published_at ? "Published: " + formatUtc(post.published_at) : null,
    post.cancelled_at ? "Cancelled: " + formatUtc(post.cancelled_at) : null,
    post.cancellation_reason ? "Cancellation reason: " + post.cancellation_reason : null,
    "",
    "CONTENT",
    post.content,
    "",
    "RECENT HISTORY",
    historyText || "No history recorded."
  ].filter(value => value !== null).join("\n");

  const keyboard = new InlineKeyboard().text("Back to History", "posthist_page:0");
  if (post.status === "rejected") {
    keyboard.row().text("Restore to Schedule", "posthist_restore:" + post.id);
  }
  if (edit) {
    await ctx.editMessageText(text, { reply_markup: keyboard });
    await ctx.answerCallbackQuery();
  } else {
    await ctx.reply(text, { reply_markup: keyboard });
  }
}

export function registerPostHistory(bot) {
  bot.command("posthistory", async (ctx) => {
    if (!isAdminPrivate(ctx)) return ctx.reply("Access denied.");
    try { await showHistory(ctx); }
    catch (error) {
      console.error("[post-history] list failed:", error);
      await ctx.reply("Unable to load post history. Please try again.");
    }
  });

  bot.command("postdetails", async (ctx) => {
    if (!isAdminPrivate(ctx)) return ctx.reply("Access denied.");
    const postId = ctx.match?.trim();
    if (!/^\d+$/.test(postId || "")) return ctx.reply("Usage: /postdetails <post_id>");
    try { await showDetails(ctx, postId); }
    catch (error) {
      console.error("[post-history] details failed:", error);
      await ctx.reply("Unable to load post details. Please try again.");
    }
  });

  bot.callbackQuery(/^posthist_page:\d+$/, async (ctx) => {
    if (!isAdminPrivate(ctx)) return ctx.answerCallbackQuery({ text: "Unauthorized.", show_alert: true });
    const page = Number(ctx.callbackQuery.data.split(":")[1]);
    try {
      await ctx.answerCallbackQuery();
      // Replace the current list message with the requested page.
      const offset = page * PAGE_SIZE;
      const result = await pool.query(
        "SELECT id, title, scheduled_at, status FROM scheduled_posts ORDER BY updated_at DESC, id DESC LIMIT $1 OFFSET $2",
        [PAGE_SIZE, offset]
      );
      const count = await pool.query("SELECT COUNT(*)::int AS total FROM scheduled_posts");
      const total = count.rows[0].total;
      if (!total) return ctx.editMessageText("No posts have been created yet.");
      const keyboard = new InlineKeyboard();
      for (const post of result.rows) keyboard.text("#" + post.id + " · " + post.status.toUpperCase(), "posthist_detail:" + post.id).row();
      if (page > 0) keyboard.text("← Previous", "posthist_page:" + (page - 1));
      if (offset + result.rowCount < total) keyboard.text("Next →", "posthist_page:" + (page + 1));
      const body = result.rows.map(post => "#" + post.id + " — " + post.title + "\nStatus: " + post.status.toUpperCase() + "\nScheduled: " + formatUtc(post.scheduled_at)).join("\n\n");
      await ctx.editMessageText("PROFINO — POST HISTORY\n\n" + body + "\n\nShowing " + (offset + 1) + "–" + (offset + result.rowCount) + " of " + total, { reply_markup: keyboard });
    } catch (error) {
      console.error("[post-history] pagination failed:", error);
      await ctx.answerCallbackQuery({ text: "Unable to load this page.", show_alert: true });
    }
  });

  bot.callbackQuery(/^posthist_detail:\d+$/, async (ctx) => {
    if (!isAdminPrivate(ctx)) return ctx.answerCallbackQuery({ text: "Unauthorized.", show_alert: true });
    try { await showDetails(ctx, ctx.callbackQuery.data.split(":")[1], true); }
    catch (error) {
      console.error("[post-history] detail callback failed:", error);
      await ctx.answerCallbackQuery({ text: "Unable to load post details.", show_alert: true });
    }
  });

  bot.callbackQuery(/^posthist_restore:\d+$/, async (ctx) => {
    if (!isAdminPrivate(ctx)) return ctx.answerCallbackQuery({ text: "Unauthorized.", show_alert: true });
    const postId = ctx.callbackQuery.data.split(":")[1];
    const result = await pool.query("SELECT id, status FROM scheduled_posts WHERE id = $1", [postId]);
    if (!result.rowCount || result.rows[0].status !== "rejected") {
      return ctx.answerCallbackQuery({ text: "Only rejected posts can be restored.", show_alert: true });
    }
    restoreSessions.set(ADMIN_ID, { postId, step: "time" });
    await ctx.answerCallbackQuery();
    await ctx.reply(
      "RESTORE POST #" + postId + "\n\nSend a new future date and time in UTC.\nFormat: YYYY-MM-DD HH:mm\nExample: 2026-11-12 18:30\n\nThe post will return to the schedule and require a fresh approval before publication. Send /cancelpost to stop."
    );
  });

  bot.callbackQuery(/^posthist_restore_confirm:\d+$/, async (ctx) => {
    if (!isAdminPrivate(ctx)) return ctx.answerCallbackQuery({ text: "Unauthorized.", show_alert: true });
    const postId = ctx.callbackQuery.data.split(":")[1];
    const session = restoreSessions.get(ADMIN_ID);
    if (!session || session.postId !== postId || !session.scheduledAt) {
      return ctx.answerCallbackQuery({ text: "Restore session expired. Start again.", show_alert: true });
    }
    try {
      const result = await pool.query(
        "UPDATE scheduled_posts SET status = 'scheduled', scheduled_at = $1, preview_message_id = NULL, preview_chat_id = NULL, approved_by = NULL, published_message_id = NULL, published_at = NULL, edit_version = COALESCE(edit_version, 0) + 1, updated_at = NOW() WHERE id = $2 AND status = 'rejected' RETURNING id, title, scheduled_at",
        [session.scheduledAt, postId]
      );
      restoreSessions.delete(ADMIN_ID);
      if (!result.rowCount) return ctx.answerCallbackQuery({ text: "Post is no longer rejected.", show_alert: true });
      await ctx.answerCallbackQuery({ text: "Post restored to schedule." });
      await ctx.editMessageText(
        "PROFINO — POST RESTORED\n\nPost: #" + postId +
        "\nTitle: " + result.rows[0].title +
        "\nNew schedule: " + formatUtc(result.rows[0].scheduled_at) +
        "\nStatus: SCHEDULED\n\nA new private preview will be sent at the scheduled time. Publication still requires your approval."
      );
    } catch (error) {
      console.error("[post-history] restore failed:", error);
      await ctx.answerCallbackQuery({ text: "Unable to restore post.", show_alert: true });
    }
  });

  bot.callbackQuery(/^posthist_restore_cancel:\d+$/, async (ctx) => {
    if (!isAdminPrivate(ctx)) return ctx.answerCallbackQuery({ text: "Unauthorized.", show_alert: true });
    restoreSessions.delete(ADMIN_ID);
    await ctx.answerCallbackQuery({ text: "Restore cancelled." });
    await ctx.editMessageText("Post restoration cancelled.");
  });

  bot.on("message:text", async (ctx, next) => {
    if (!isAdminPrivate(ctx)) return next();
    const session = restoreSessions.get(ADMIN_ID);
    if (!session || session.step !== "time") return next();
    const value = ctx.message.text.trim();
    if (value.startsWith("/")) return next();
    const date = parseUtcDateTime(value);
    if (!date) {
      await ctx.reply("Invalid date/time. Use YYYY-MM-DD HH:mm UTC and choose a future time, or /cancelpost.");
      return;
    }
    session.scheduledAt = date.toISOString();
    session.step = "confirm";
    const keyboard = new InlineKeyboard()
      .text("Confirm Restore", "posthist_restore_confirm:" + session.postId)
      .text("Cancel", "posthist_restore_cancel:" + session.postId);
    await ctx.reply(
      "CONFIRM POST RESTORATION\n\nPost: #" + session.postId +
      "\nNew schedule: " + formatUtc(session.scheduledAt) +
      "\n\nThe post will be scheduled, not published. A fresh preview and your approval will still be required.",
      { reply_markup: keyboard }
    );
  });
}

export function clearPostHistorySession(userId) {
  return restoreSessions.delete(userId);
}
