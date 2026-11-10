import { InlineKeyboard } from "grammy";
import { pool } from "./database.js";
import { getAdminLanguage, adminText } from "./admin-language.js";

const ADMIN_ID = 8810232463;
const sessions = new Map();

function previewKeyboard(postId, language = "en") {
  return new InlineKeyboard()
    .text(adminText(language, "Approve & Publish", "تأیید و انتشار"), "post_approve:" + postId)
    .text(adminText(language, "Reject", "رد کردن"), "post_reject:" + postId)
    .row()
    .text(adminText(language, "Edit Post", "ویرایش پست"), "post_edit:" + postId)
    .text(adminText(language, "Reschedule", "تغییر زمان"), "post_time:" + postId)
    .row()
    .text(adminText(language, "Cancel Post", "لغو پست"), "post_cancel:" + postId);
}

function parseUtcDateTime(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})$/.exec(value);
  if (!match) return null;
  const y = Number(match[1]);
  const mo = Number(match[2]);
  const d = Number(match[3]);
  const h = Number(match[4]);
  const mi = Number(match[5]);
  if (y < 2000 || mo < 1 || mo > 12 || h > 23 || mi > 59) return null;

  const date = new Date(Date.UTC(y, mo - 1, d, h, mi, 0));
  if (
    date.getUTCFullYear() !== y ||
    date.getUTCMonth() !== mo - 1 ||
    date.getUTCDate() !== d ||
    date.getUTCHours() !== h ||
    date.getUTCMinutes() !== mi ||
    date.getTime() <= Date.now() + 60000
  ) return null;
  return date;
}

async function getCurrentPreview(ctx, postId) {
  const message = ctx.callbackQuery && ctx.callbackQuery.message;
  if (
    ctx.from?.id !== ADMIN_ID ||
    message?.chat?.type !== "private" ||
    Number(message.chat.id) !== ADMIN_ID
  ) return null;

  const result = await pool.query(
    "SELECT id, title, content, scheduled_at, edit_version, " +
    "preview_message_id, preview_chat_id FROM scheduled_posts " +
    "WHERE id = $1 AND status = 'preview_sent' " +
    "AND preview_message_id = $2 AND preview_chat_id = $3",
    [postId, message.message_id, message.chat.id]
  );
  return result.rows[0] || null;
}

async function invalidateOldPreview(ctx, chatId, messageId, text) {
  try {
    await ctx.api.editMessageText(chatId, messageId, text, { reply_markup: { inline_keyboard: [] } });
  } catch (error) {
    console.error("[post-management] could not invalidate old preview:", error);
  }
}

function utcLabel(date, language = "en") {
  return new Date(date).toLocaleString(language === "fa" ? "fa-IR" : "en-GB", {
    timeZone: "UTC",
    dateStyle: "medium",
    timeStyle: "short"
  }) + (language === "fa" ? " (UTC)" : " UTC");
}

function previewText(post, language = "en") {
  return [
    adminText(language, "PROFINO — POST PREVIEW", "پروفینو — پیش‌نمایش پست"),
    "",
    adminText(language, "Post ID: ", "شناسه پست: ") + post.id,
    adminText(language, "Title: ", "عنوان: ") + post.title,
    "",
    post.content,
    "",
    adminText(language, "Scheduled time: ", "زمان‌بندی: ") + utcLabel(post.scheduled_at, language),
    "",
    adminText(language, "This post will NOT be published until you approve it.", "این پست تا زمان تأیید شما منتشر نخواهد شد.")
  ].join("\n");
}

export function clearPostManagementSession(userId) {
  return sessions.delete(userId);
}

export function registerPostManagement(bot) {
  bot.callbackQuery(/^post_edit:\d+$/, async (ctx) => {
    const postId = ctx.callbackQuery.data.split(":")[1];
    const language = await getAdminLanguage(ctx);
    try {
      const post = await getCurrentPreview(ctx, postId);
      if (!post) {
        await ctx.answerCallbackQuery({ text: adminText(language, "This preview is no longer valid.", "این پیش‌نمایش دیگر معتبر نیست."), show_alert: true });
        return;
      }
      const keyboard = new InlineKeyboard()
        .text(adminText(language, "Edit Title", "ویرایش عنوان"), "post_edit_title:" + postId)
        .text(adminText(language, "Edit Content", "ویرایش محتوا"), "post_edit_content:" + postId)
        .row()
        .text(adminText(language, "Back", "بازگشت"), "post_edit_back:" + postId);
      await ctx.answerCallbackQuery();
      await ctx.editMessageText(
        adminText(language, "EDIT POST #", "ویرایش پست شماره ") + postId + "\n\n" + adminText(language, "Choose which field you want to change. The existing preview will become invalid after you save the edit.", "مشخص کنید کدام بخش را می‌خواهید تغییر دهید. پس از ذخیره، پیش‌نمایش فعلی نامعتبر می‌شود."),
        { reply_markup: keyboard }
      );
    } catch (error) {
      console.error("[post-management] edit menu failed:", error);
      await ctx.answerCallbackQuery({ text: adminText(language, "Unable to open edit options.", "باز کردن گزینه‌های ویرایش ممکن نشد."), show_alert: true });
    }
  });

  bot.callbackQuery(/^post_edit_title:\d+$/, async (ctx) => {
    await startFieldEdit(ctx, "title");
  });
  bot.callbackQuery(/^post_edit_content:\d+$/, async (ctx) => {
    await startFieldEdit(ctx, "content");
  });

  bot.callbackQuery(/^post_edit_back:\d+$/, async (ctx) => {
    const language = await getAdminLanguage(ctx);
    const postId = ctx.callbackQuery.data.split(":")[1];
    sessions.delete(ADMIN_ID);
    try {
      const post = await getCurrentPreview(ctx, postId);
      if (!post) {
        await ctx.answerCallbackQuery({ text: "This preview is no longer valid.", show_alert: true });
        return;
      }
      await ctx.answerCallbackQuery();
      await ctx.editMessageText(previewText(post, language), { reply_markup: previewKeyboard(postId, language) });
    } catch (error) {
      console.error("[post-management] could not restore preview:", error);
      await ctx.answerCallbackQuery({ text: adminText(language, "Unable to restore preview.", "بازیابی پیش‌نمایش ممکن نشد."), show_alert: true });
    }
  });

  bot.callbackQuery(/^post_time:\d+$/, async (ctx) => {
    const language = await getAdminLanguage(ctx);
    const postId = ctx.callbackQuery.data.split(":")[1];
    try {
      const post = await getCurrentPreview(ctx, postId);
      if (!post) {
        await ctx.answerCallbackQuery({ text: "This preview is no longer valid.", show_alert: true });
        return;
      }
      sessions.set(ADMIN_ID, {
        postId: String(post.id),
        field: "scheduled_at",
        editVersion: post.edit_version,
        previewMessageId: post.preview_message_id,
        previewChatId: post.preview_chat_id
      });
      await ctx.answerCallbackQuery();
      await ctx.reply(
        adminText(language, "RESCHEDULE POST #" + postId + "\n\nSend the new date and time in UTC using this exact format:\nYYYY-MM-DD HH:mm\n\nExample: 2026-11-12 15:30\n\nThe time must be at least one minute in the future. Send /cancelpost to stop.", "تغییر زمان پست شماره " + postId + "\n\nتاریخ و زمان جدید را با ساعت UTC و دقیقاً در این قالب بفرستید:\nYYYY-MM-DD HH:mm\n\nنمونه: 2026-11-12 15:30\n\nزمان باید حداقل یک دقیقه در آینده باشد. برای لغو /cancelpost را بفرستید.")
      );
    } catch (error) {
      console.error("[post-management] reschedule session failed:", error);
      await ctx.answerCallbackQuery({ text: adminText(language, "Unable to start rescheduling.", "شروع تغییر زمان ممکن نشد."), show_alert: true });
    }
  });

  bot.callbackQuery(/^post_cancel:\d+$/, async (ctx) => {
    const language = await getAdminLanguage(ctx);
    const postId = ctx.callbackQuery.data.split(":")[1];
    try {
      const post = await getCurrentPreview(ctx, postId);
      if (!post) {
        await ctx.answerCallbackQuery({ text: "This preview is no longer valid.", show_alert: true });
        return;
      }
      const keyboard = new InlineKeyboard()
        .text(adminText(language, "Confirm Cancellation", "تأیید لغو"), "post_cancel_confirm:" + postId)
        .text(adminText(language, "Keep Post", "نگه‌داشتن پست"), "post_cancel_back:" + postId);
      await ctx.answerCallbackQuery();
      await ctx.editMessageText(
        adminText(language, "CANCEL POST #", "لغو پست شماره ") + postId + "\n\n" + adminText(language, "Are you sure? This action cannot be undone from the bot.", "آیا مطمئن هستید؟ این عملیات از طریق ربات قابل بازگشت نیست."),
        { reply_markup: keyboard }
      );
    } catch (error) {
      console.error("[post-management] cancel confirmation failed:", error);
      await ctx.answerCallbackQuery({ text: adminText(language, "Unable to open cancellation confirmation.", "باز کردن تأیید لغو ممکن نشد."), show_alert: true });
    }
  });

  bot.callbackQuery(/^post_cancel_back:\d+$/, async (ctx) => {
    const language = await getAdminLanguage(ctx);
    const postId = ctx.callbackQuery.data.split(":")[1];
    try {
      const post = await getCurrentPreview(ctx, postId);
      if (!post) {
        await ctx.answerCallbackQuery({ text: "This preview is no longer valid.", show_alert: true });
        return;
      }
      await ctx.answerCallbackQuery({ text: adminText(language, "Post kept.", "پست حفظ شد.") });
      await ctx.editMessageText(previewText(post, language), { reply_markup: previewKeyboard(postId, language) });
    } catch (error) {
      console.error("[post-management] could not restore preview after cancellation abort:", error);
      await ctx.answerCallbackQuery({ text: "Unable to restore preview.", show_alert: true });
    }
  });

  bot.callbackQuery(/^post_cancel_confirm:\d+$/, async (ctx) => {
    const language = await getAdminLanguage(ctx);
    const postId = ctx.callbackQuery.data.split(":")[1];
    try {
      const post = await getCurrentPreview(ctx, postId);
      if (!post) {
        await ctx.answerCallbackQuery({ text: "This preview is no longer valid.", show_alert: true });
        return;
      }
      const result = await pool.query(
        "UPDATE scheduled_posts SET status = 'cancelled', cancelled_at = NOW(), " +
        "cancellation_reason = 'Cancelled by administrator', preview_message_id = NULL, " +
        "preview_chat_id = NULL, approved_by = NULL, edit_version = edit_version + 1, " +
        "updated_at = NOW() WHERE id = $1 AND status = 'preview_sent' " +
        "AND preview_message_id = $2 AND preview_chat_id = $3 AND edit_version = $4 " +
        "RETURNING id",
        [postId, post.preview_message_id, post.preview_chat_id, post.edit_version]
      );
      if (!result.rowCount) {
        await ctx.answerCallbackQuery({ text: adminText(language, "Post changed or is no longer available.", "پست تغییر کرده یا دیگر در دسترس نیست."), show_alert: true });
        return;
      }
      await ctx.answerCallbackQuery({ text: adminText(language, "Post cancelled.", "پست لغو شد.") });
      await invalidateOldPreview(
        ctx,
        post.preview_chat_id,
        post.preview_message_id,
        adminText(language, "PROFINO — Post #" + postId + " was cancelled by the administrator.", "پروفینو — پست شماره " + postId + " توسط مدیر لغو شد.")
      );
    } catch (error) {
      console.error("[post-management] cancellation failed:", error);
      await ctx.answerCallbackQuery({ text: adminText(language, "Unable to cancel this post.", "لغو این پست ممکن نشد."), show_alert: true });
    }
  });

  bot.on("message:text", async (ctx, next) => {
    if (ctx.from?.id !== ADMIN_ID || ctx.chat?.type !== "private") return next();
    const session = sessions.get(ADMIN_ID);
    if (!session) return next();

    const language = await getAdminLanguage(ctx);
    const value = ctx.message.text.trim();
    if (value.startsWith("/")) return next();

    if (session.field === "title" && (!value || value.length > 255)) {
      await ctx.reply(adminText(language, "Invalid title. Please send 1–255 characters, or /cancelpost.", "عنوان نامعتبر است. متنی بین ۱ تا ۲۵۵ نویسه بفرستید یا /cancelpost را ارسال کنید."));
      return;
    }
    if (session.field === "content" && (!value || value.length > 3500)) {
      await ctx.reply(adminText(language, "Invalid content. Please send 1–3500 characters, or /cancelpost.", "محتوای نامعتبر است. متنی بین ۱ تا ۳۵۰۰ نویسه بفرستید یا /cancelpost را ارسال کنید."));
      return;
    }

    let scheduledAt = null;
    if (session.field === "scheduled_at") {
      scheduledAt = parseUtcDateTime(value);
      if (!scheduledAt) {
        await ctx.reply(
          adminText(language, "Invalid UTC date/time. Use YYYY-MM-DD HH:mm, choose a real calendar date, and set it at least one minute in the future. Or send /cancelpost.", "تاریخ یا زمان UTC نامعتبر است. قالب YYYY-MM-DD HH:mm را رعایت کنید، تاریخ واقعی و زمانی حداقل یک دقیقه بعد انتخاب کنید؛ یا /cancelpost را بفرستید.")
        );
        return;
      }
    }

    try {
      let result;
      if (session.field === "scheduled_at") {
        result = await pool.query(
          "UPDATE scheduled_posts SET scheduled_at = $1, status = 'scheduled', " +
          "preview_message_id = NULL, preview_chat_id = NULL, approved_by = NULL, " +
          "edit_version = edit_version + 1, last_edited_at = NOW(), updated_at = NOW() " +
          "WHERE id = $2 AND status = 'preview_sent' AND preview_message_id = $3 " +
          "AND preview_chat_id = $4 AND edit_version = $5 RETURNING id, scheduled_at",
          [scheduledAt.toISOString(), session.postId, session.previewMessageId, session.previewChatId, session.editVersion]
        );
      } else {
        const column = session.field === "title" ? "title" : "content";
        result = await pool.query(
          "UPDATE scheduled_posts SET " + column + " = $1, " +
          "scheduled_at = GREATEST(scheduled_at, NOW() + INTERVAL '1 minute'), " +
          "status = 'scheduled', preview_message_id = NULL, preview_chat_id = NULL, " +
          "approved_by = NULL, edit_version = edit_version + 1, last_edited_at = NOW(), " +
          "updated_at = NOW() WHERE id = $2 AND status = 'preview_sent' " +
          "AND preview_message_id = $3 AND preview_chat_id = $4 AND edit_version = $5 " +
          "RETURNING id, scheduled_at",
          [value, session.postId, session.previewMessageId, session.previewChatId, session.editVersion]
        );
      }

      sessions.delete(ADMIN_ID);
      if (!result.rowCount) {
        await ctx.reply(adminText(language, "This preview is no longer current. No changes were saved. Open the latest preview to try again.", "این پیش‌نمایش دیگر معتبر نیست و تغییری ذخیره نشد. آخرین پیش‌نمایش را باز کنید و دوباره تلاش کنید."));
        return;
      }

      await invalidateOldPreview(
        ctx,
        session.previewChatId,
        session.previewMessageId,
        "PROFINO — Preview for post #" + session.postId +
        " is no longer valid. The post was updated and returned to the schedule."
      );
      await ctx.reply(
        "Post #" + session.postId + " updated successfully.\n" +
        "Status: SCHEDULED\nScheduled time: " + utcLabel(result.rows[0].scheduled_at) +
        "\n\nA new private preview will be sent at the scheduled time. " +
        "Publishing still requires your approval."
      );
    } catch (error) {
      console.error("[post-management] saving change failed:", error);
      await ctx.reply(adminText(language, "Unable to save the change. Please try again or send /cancelpost.", "ذخیره تغییر ممکن نشد. دوباره تلاش کنید یا /cancelpost را بفرستید."));
    }
  });
}

async function startFieldEdit(ctx, field) {
  const language = await getAdminLanguage(ctx);
  const postId = ctx.callbackQuery.data.split(":")[1];
  try {
    const post = await getCurrentPreview(ctx, postId);
    if (!post) {
      await ctx.answerCallbackQuery({ text: "This preview is no longer valid.", show_alert: true });
      return;
    }
    sessions.set(ADMIN_ID, {
      postId: String(post.id),
      field,
      editVersion: post.edit_version,
      previewMessageId: post.preview_message_id,
      previewChatId: post.preview_chat_id
    });
    await ctx.answerCallbackQuery();
    await ctx.editMessageReplyMarkup({
      reply_markup: new InlineKeyboard().text(adminText(language, "Back", "بازگشت"), "post_edit_back:" + postId)
    });
    await ctx.reply(
      field === "title"
        ? "Send the new title for post #" + postId + " (1–255 characters). Send /cancelpost to stop."
        : "Send the new content for post #" + postId + " (1–3500 characters). Send /cancelpost to stop."
    );
  } catch (error) {
    console.error("[post-management] edit session failed:", error);
    await ctx.answerCallbackQuery({ text: adminText(language, "Unable to start editing.", "شروع ویرایش ممکن نشد."), show_alert: true });
  }
}
