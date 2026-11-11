import { safeDiagnosticCode } from "./diagnostic-safety.js";
import { InlineKeyboard } from "grammy";
import { pool } from "./database.js";
import { getAdminLanguage, adminText } from "./admin-language.js";

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

function formatUtc(value, language = "en") {
  return new Date(value).toLocaleString(language === "fa" ? "fa-IR" : "en-GB", {
    timeZone: "UTC", dateStyle: "medium", timeStyle: "short"
  }) + (language === "fa" ? " (UTC)" : " UTC");
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

async function showHistory(ctx, page = 0, status = "all", edit = false) {
  const language = await getAdminLanguage(ctx);
  const offset = page * PAGE_SIZE;
  const result = await pool.query(
    `SELECT id, title, scheduled_at, status, updated_at
     FROM scheduled_posts
     WHERE ($1 = 'all' OR status = $1)
     ORDER BY updated_at DESC, id DESC
     LIMIT $2 OFFSET $3`,
    [status, PAGE_SIZE, offset]
  );
  const count = await pool.query(
    "SELECT COUNT(*)::int AS total FROM scheduled_posts WHERE ($1 = 'all' OR status = $1)",
    [status]
  );
  const total = count.rows[0].total;
  if (!total) {
    const empty = adminText(language, "No posts found for status: ", "هیچ پستی با وضعیت ") + status.toUpperCase() + adminText(language, ".", " پیدا نشد.");
    if (edit) return ctx.editMessageText(empty);
    return ctx.reply(empty);
  }

  const keyboard = new InlineKeyboard();
  for (const filter of ["all", "scheduled", "preview_sent", "published", "rejected", "cancelled"]) {
    keyboard.text(filter === "all" ? adminText(language, "All", "همه") : (language === "fa" ? ({ scheduled: "زمان‌بندی‌شده", preview_sent: "پیش‌نمایش ارسال‌شده", published: "منتشرشده", rejected: "ردشده", cancelled: "لغوشده" }[filter] || filter) : filter.replaceAll("_", " ").toUpperCase()),
      "posthist_filter:" + filter);
  }
  keyboard.row();
  for (const post of result.rows) {
    keyboard.text("#" + post.id + " · " + (language === "fa" ? ({ scheduled: "زمان‌بندی‌شده", preview_sent: "پیش‌نمایش ارسال‌شده", published: "منتشرشده", rejected: "ردشده", cancelled: "لغوشده" }[post.status] || post.status) : post.status.toUpperCase()), "posthist_detail:" + post.id).row();
  }
  if (page > 0) keyboard.text(adminText(language, "← Previous", "← قبلی"), "posthist_page:" + status + ":" + (page - 1));
  if (offset + result.rowCount < total) keyboard.text(adminText(language, "Next →", "بعدی →"), "posthist_page:" + status + ":" + (page + 1));
  const body = result.rows.map(post =>
    "#" + post.id + " — " + post.title + "\n" +
    adminText(language, "Status: ", "وضعیت: ") + (language === "fa" ? ({ scheduled: "زمان‌بندی‌شده", preview_sent: "پیش‌نمایش ارسال‌شده", published: "منتشرشده", rejected: "ردشده", cancelled: "لغوشده" }[post.status] || post.status) : post.status.toUpperCase()) + "\n" +
    adminText(language, "Scheduled: ", "زمان‌بندی: ") + formatUtc(post.scheduled_at, language)
  ).join("\n\n");
  const message = adminText(language, "PROFINO — POST HISTORY (", "پروفینو — تاریخچه پست‌ها (") + status.toUpperCase() + ")\n\n" + body + adminText(language, "\n\nShowing ", "\n\nنمایش ") + (offset + 1) + "–" + (offset + result.rowCount) + adminText(language, " of ", " از ") + total;
  if (edit) return ctx.editMessageText(message, { reply_markup: keyboard });
  return ctx.reply(message, { reply_markup: keyboard });
}

async function showDetails(ctx, postId, edit = false) {
  const language = await getAdminLanguage(ctx);
  const result = await pool.query(
    "SELECT id, title, content, scheduled_at, status, created_at, updated_at, published_at, cancelled_at, cancellation_reason, published_message_id FROM scheduled_posts WHERE id = $1",
    [postId]
  );
  if (!result.rowCount) {
    if (ctx.callbackQuery) {
      await ctx.answerCallbackQuery({ text: adminText(language, "Post not found.", "پست پیدا نشد."), show_alert: true });
    } else {
      await ctx.reply(adminText(language, "Post not found.", "پست پیدا نشد."));
    }
    return;
  }
  const post = result.rows[0];
  const history = await pool.query(
    "SELECT event_type, old_status, new_status, details, changed_at FROM scheduled_post_history WHERE post_id = $1 ORDER BY changed_at DESC LIMIT 10",
    [postId]
  );
  const historyText = history.rows.map(item =>
    formatUtc(item.changed_at, language) + " — " + (language === "fa" ? ({ created: "ایجاد شد", status_changed: "تغییر وضعیت", rescheduled: "تغییر زمان", content_edited: "ویرایش محتوا", tracking_started: "شروع ثبت تاریخچه" }[item.event_type] || item.event_type) : item.event_type.toUpperCase()) +
    (item.old_status || item.new_status ? " (" + (item.old_status || "—") + " → " + (item.new_status || "—") + ")" : "")
  ).join("\n");
  const text = [
    adminText(language, "PROFINO — POST #", "پروفینو — پست شماره ") + post.id,
    "",
    adminText(language, "Title: ", "عنوان: ") + post.title,
    adminText(language, "Status: ", "وضعیت: ") + (language === "fa" ? ({ scheduled: "زمان‌بندی‌شده", preview_sent: "پیش‌نمایش ارسال‌شده", published: "منتشرشده", rejected: "ردشده", cancelled: "لغوشده", preview_unknown: "وضعیت پیش‌نمایش نامشخص", publishing: "در حال انتشار", publish_unknown: "وضعیت انتشار نامشخص", failed: "ناموفق" }[post.status] || post.status) : post.status.toUpperCase()),
    adminText(language, "Scheduled: ", "زمان‌بندی: ") + formatUtc(post.scheduled_at, language),
    adminText(language, "Created: ", "ایجاد: ") + formatUtc(post.created_at, language),
    adminText(language, "Updated: ", "به‌روزرسانی: ") + formatUtc(post.updated_at, language),
    post.published_at ? adminText(language, "Published: ", "انتشار: ") + formatUtc(post.published_at, language) : null,
    post.cancelled_at ? adminText(language, "Cancelled: ", "لغو: ") + formatUtc(post.cancelled_at, language) : null,
    post.cancellation_reason ? adminText(language, "Cancellation reason: ", "دلیل لغو: ") + post.cancellation_reason : null,
    "",
    adminText(language, "CONTENT", "محتوا"),
    post.content,
    "",
    adminText(language, "RECENT HISTORY", "تاریخچه اخیر"),
    historyText || adminText(language, "No history recorded.", "تاریخچه‌ای ثبت نشده است.")
  ].filter(value => value !== null).join("\n");

  const keyboard = new InlineKeyboard().text(adminText(language, "Back to History", "بازگشت به تاریخچه"), "posthist_filter:all");
  if (post.status === "rejected") {
    keyboard.row().text(adminText(language, "Restore to Schedule", "بازگردانی به زمان‌بندی"), "posthist_restore:" + post.id);
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
    const language = await getAdminLanguage(ctx);
    if (!isAdminPrivate(ctx)) return ctx.reply(adminText(language, "Access denied.", "دسترسی غیرمجاز است."));
    const requestedStatus = ctx.match?.trim().toLowerCase() || "all";
    const validStatuses = ["all", "scheduled", "preview_sending", "preview_sent", "preview_unknown", "approved", "publishing", "publish_unknown", "published", "rejected", "cancelled", "failed"];
    if (!validStatuses.includes(requestedStatus)) {
      return ctx.reply(adminText(language, "Invalid status. Use /posthistory followed by: all, scheduled, preview_sent, published, rejected, cancelled, or failed.", "وضعیت نامعتبر است. پس از /posthistory یکی از این موارد را وارد کنید: all, scheduled, preview_sent, published, rejected, cancelled, failed."));
    }
    try { await showHistory(ctx, 0, requestedStatus); }
    catch (error) {
      console.error("[post-history] list failed:", safeDiagnosticCode(error));
      await ctx.reply(adminText(language, "Unable to load post history. Please try again.", "بارگذاری تاریخچه پست‌ها ممکن نشد. دوباره تلاش کنید."));
    }
  });

  bot.command("postdetails", async (ctx) => {
    const language = await getAdminLanguage(ctx);
    if (!isAdminPrivate(ctx)) return ctx.reply(adminText(language, "Access denied.", "دسترسی غیرمجاز است."));
    const postId = ctx.match?.trim();
    if (!/^\d+$/.test(postId || "")) return ctx.reply(adminText(language, "Usage: /postdetails <post_id>", "نحوه استفاده: /postdetails <post_id>"));
    try { await showDetails(ctx, postId); }
    catch (error) {
      console.error("[post-history] details failed:", safeDiagnosticCode(error));
      await ctx.reply(adminText(language, "Unable to load post details. Please try again.", "بارگذاری جزئیات پست ممکن نشد. دوباره تلاش کنید."));
    }
  });

  bot.callbackQuery(/^posthist_filter:(all|scheduled|preview_sent|published|rejected|cancelled)$/, async (ctx) => {
    const language = await getAdminLanguage(ctx);
    if (!isAdminPrivate(ctx)) return ctx.answerCallbackQuery({ text: adminText(language, "Unauthorized.", "دسترسی غیرمجاز است."), show_alert: true });
    try {
      await ctx.answerCallbackQuery();
      await showHistory(ctx, 0, ctx.callbackQuery.data.split(":")[1], true);
    } catch (error) {
      console.error("[post-history] filter failed:", safeDiagnosticCode(error));
      await ctx.answerCallbackQuery({ text: adminText(language, "Unable to apply this filter.", "اعمال این فیلتر ممکن نشد."), show_alert: true });
    }
  });

  bot.callbackQuery(/^posthist_page:(all|scheduled|preview_sent|published|rejected|cancelled):\d+$/, async (ctx) => {
    const language = await getAdminLanguage(ctx);
    if (!isAdminPrivate(ctx)) return ctx.answerCallbackQuery({ text: "Unauthorized.", show_alert: true });
    const [, status, pageText] = ctx.callbackQuery.data.split(":");
    try {
      await ctx.answerCallbackQuery();
      await showHistory(ctx, Number(pageText), status, true);
    } catch (error) {
      console.error("[post-history] pagination failed:", safeDiagnosticCode(error));
      await ctx.answerCallbackQuery({ text: adminText(language, "Unable to load this page.", "بارگذاری این صفحه ممکن نشد."), show_alert: true });
    }
  });

  bot.callbackQuery(/^posthist_detail:\d+$/, async (ctx) => {
    const language = await getAdminLanguage(ctx);
    if (!isAdminPrivate(ctx)) return ctx.answerCallbackQuery({ text: "Unauthorized.", show_alert: true });
    try { await showDetails(ctx, ctx.callbackQuery.data.split(":")[1], true); }
    catch (error) {
      console.error("[post-history] detail callback failed:", safeDiagnosticCode(error));
      await ctx.answerCallbackQuery({ text: adminText(language, "Unable to load post details.", "بارگذاری جزئیات پست ممکن نشد."), show_alert: true });
    }
  });

  bot.callbackQuery(/^posthist_restore:\d+$/, async (ctx) => {
    if (!isAdminPrivate(ctx)) return ctx.answerCallbackQuery({ text: "Unauthorized.", show_alert: true });
    const language = await getAdminLanguage(ctx);
    const postId = ctx.callbackQuery.data.split(":")[1];
    const result = await pool.query("SELECT id, status FROM scheduled_posts WHERE id = $1", [postId]);
    if (!result.rowCount || result.rows[0].status !== "rejected") {
      return ctx.answerCallbackQuery({ text: adminText(language, "Only rejected posts can be restored.", "فقط پست‌های ردشده قابل بازگردانی هستند."), show_alert: true });
    }
    restoreSessions.set(ADMIN_ID, { postId, step: "time" });
    await ctx.answerCallbackQuery();
    await ctx.reply(
      adminText(language, "RESTORE POST #" + postId + "\n\nSend a new future date and time in UTC.\nFormat: YYYY-MM-DD HH:mm\nExample: 2026-11-12 18:30\n\nThe post will return to the schedule and require a fresh approval before publication. Send /cancelpost to stop.", "بازگردانی پست شماره " + postId + "\n\nتاریخ و زمان آینده را با ساعت UTC ارسال کنید.\nقالب: YYYY-MM-DD HH:mm\nنمونه: 2026-11-12 18:30\n\nپست به برنامه زمان‌بندی بازمی‌گردد و پیش از انتشار به تأیید مجدد نیاز دارد. برای لغو /cancelpost را بفرستید.")
    );
  });

  bot.callbackQuery(/^posthist_restore_confirm:\d+$/, async (ctx) => {
    const language = await getAdminLanguage(ctx);
    if (!isAdminPrivate(ctx)) return ctx.answerCallbackQuery({ text: "Unauthorized.", show_alert: true });
    const postId = ctx.callbackQuery.data.split(":")[1];
    const session = restoreSessions.get(ADMIN_ID);
    if (!session || session.postId !== postId || !session.scheduledAt) {
      return ctx.answerCallbackQuery({ text: adminText(language, "Restore session expired. Start again.", "مهلت نشست بازگردانی تمام شده است. دوباره شروع کنید."), show_alert: true });
    }
    try {
      const result = await pool.query(
        "UPDATE scheduled_posts SET status = 'scheduled', scheduled_at = $1, preview_message_id = NULL, preview_chat_id = NULL, approved_by = NULL, published_message_id = NULL, published_at = NULL, edit_version = COALESCE(edit_version, 0) + 1, updated_at = NOW() WHERE id = $2 AND status = 'rejected' RETURNING id, title, scheduled_at",
        [session.scheduledAt, postId]
      );
      restoreSessions.delete(ADMIN_ID);
      if (!result.rowCount) return ctx.answerCallbackQuery({ text: adminText(language, "Post is no longer rejected.", "وضعیت پست دیگر «ردشده» نیست."), show_alert: true });
      await ctx.answerCallbackQuery({ text: adminText(language, "Post restored to schedule.", "پست به برنامه زمان‌بندی بازگردانده شد.") });
      await ctx.editMessageText(
        adminText(language, "PROFINO — POST RESTORED\n\nPost: #" + postId + "\nTitle: " + result.rows[0].title + "\nNew schedule: " + formatUtc(result.rows[0].scheduled_at) + "\nStatus: SCHEDULED\n\nA new private preview will be sent at the scheduled time. Publication still requires your approval.", "پروفینو — پست بازگردانی شد\n\nپست: شماره " + postId + "\nعنوان: " + result.rows[0].title + "\nزمان جدید: " + formatUtc(result.rows[0].scheduled_at, language) + "\nوضعیت: زمان‌بندی‌شده\n\nدر زمان مقرر پیش‌نمایش خصوصی جدید ارسال می‌شود. انتشار همچنان به تأیید شما نیاز دارد.")
      );
    } catch (error) {
      console.error("[post-history] restore failed:", safeDiagnosticCode(error));
      await ctx.answerCallbackQuery({ text: adminText(language, "Unable to restore post.", "بازگردانی پست ممکن نشد."), show_alert: true });
    }
  });

  bot.callbackQuery(/^posthist_restore_cancel:\d+$/, async (ctx) => {
    const language = await getAdminLanguage(ctx);
    if (!isAdminPrivate(ctx)) return ctx.answerCallbackQuery({ text: "Unauthorized.", show_alert: true });
    restoreSessions.delete(ADMIN_ID);
    await ctx.answerCallbackQuery({ text: adminText(language, "Restore cancelled.", "بازگردانی لغو شد.") });
    await ctx.editMessageText(adminText(language, "Post restoration cancelled.", "عملیات بازگردانی پست لغو شد."));
  });

  bot.on("message:text", async (ctx, next) => {
    if (!isAdminPrivate(ctx)) return next();
    const session = restoreSessions.get(ADMIN_ID);
    if (!session || session.step !== "time") return next();
    const language = await getAdminLanguage(ctx);
    const value = ctx.message.text.trim();
    if (value.startsWith("/")) return next();
    const date = parseUtcDateTime(value);
    if (!date) {
      await ctx.reply(adminText(language, "Invalid date/time. Use YYYY-MM-DD HH:mm UTC and choose a future time, or /cancelpost.", "تاریخ یا زمان نامعتبر است. قالب YYYY-MM-DD HH:mm با ساعت UTC و زمانی در آینده وارد کنید یا /cancelpost را بفرستید."));
      return;
    }
    session.scheduledAt = date.toISOString();
    session.step = "confirm";
    const keyboard = new InlineKeyboard()
      .text(adminText(language, "Confirm Restore", "تأیید بازگردانی"), "posthist_restore_confirm:" + session.postId)
      .text(adminText(language, "Cancel", "لغو"), "posthist_restore_cancel:" + session.postId);
    await ctx.reply(
      adminText(language, "CONFIRM POST RESTORATION\n\nPost: #" + session.postId + "\nNew schedule: " + formatUtc(session.scheduledAt, language) + "\n\nThe post will be scheduled, not published. A fresh preview and your approval will still be required.", "تأیید بازگردانی پست\n\nپست: شماره " + session.postId + "\nزمان‌بندی جدید: " + formatUtc(session.scheduledAt, language) + "\n\nپست زمان‌بندی می‌شود و فوراً منتشر نخواهد شد. پیش‌نمایش جدید و تأیید شما همچنان الزامی است."),
      { reply_markup: keyboard }
    );
  });
}

export function clearPostHistorySession(userId) {
  return restoreSessions.delete(userId);
}
