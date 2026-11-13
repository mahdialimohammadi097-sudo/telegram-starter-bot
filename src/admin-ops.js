import { postStatusLabel } from "./post-schedule.js";
import { previewSettlement } from "./plan-preview.js";
import { InlineKeyboard } from "grammy";
import { pool } from "./database.js";
import { isConfirmationCurrent } from "./admin-status-guard.js";
import { inspectCoreSchema, formatCoreSchema } from "./database-diagnostics.js";
import { adminText, getAdminLanguage } from "./admin-language.js";
import { rollbackTransaction } from "./transaction-safety.js";
import { safeDiagnosticCode } from "./diagnostic-safety.js";

const SUPER_ADMIN_ID = 8810232463;
const PAGE_SIZE = 8;

function isSuperAdminPrivate(ctx) {
  return ctx.from?.id === SUPER_ADMIN_ID && ctx.chat?.type === "private";
}

function userStatusLabel(status, language) {
  if (language === "fa") {
    switch (status) {
      case "active": return "فعال";
      case "blocked": return "مسدود";
      case "pending": return "در انتظار";
    }
  }
  return status.toUpperCase();
}

function formatDate(value, language = "en") {
  if (!value) return "—";
  return new Date(value).toLocaleString(language === "fa" ? "fa-IR" : "en-GB", {
    timeZone: "UTC",
    dateStyle: "medium",
    timeStyle: "short"
  }) + (language === "fa" ? " (UTC)" : " UTC");
}

function dashboardKeyboard(language = "en", showQueue = false) {
  const labels = language === "fa"
    ? { overview: "نمای کلی", users: "کاربران", posts: "پست‌ها", activity: "فعالیت‌ها", language: "زبان", refresh: "بروزرسانی" }
    : { overview: "Overview", users: "Users", posts: "Posts", activity: "Activity", language: "Language", refresh: "Refresh" };
  const keyboard = new InlineKeyboard()
    .text(labels.overview, "admin_home")
    .row()
    .text(labels.users, "admin_users:0")
    .text(labels.posts, "admin_posts")
    .row()
    .text(labels.activity, "admin_logs")
    .text(labels.language, "admin_language")
    .text(labels.refresh, "admin_refresh");
  if (showQueue) keyboard.row().text(adminText(language, "Settlement queue", "صف تسویه"), "admin_simqueue");
  return keyboard;
}

async function recordAdminActivity(ctx, action, targetUserIdInput = null, details = {}) {
  if (!isSuperAdminPrivate(ctx)) {
    return { ok: false, error: "Super Admin private-chat check did not pass." };
  }
  try {
    const admin = await pool.query(
      `SELECT au.user_id
       FROM admin_users au
       JOIN users u ON u.id = au.user_id
       WHERE u.telegram_id = $1 AND au.role = 'owner' AND au.status = 'active'
       LIMIT 1`,
      [ctx.from.id]
    );
    if (!admin.rowCount) {
      return { ok: false, error: "No active admin_users record is linked to this Telegram account." };
    }

    let targetUserId = null;
    if (targetUserIdInput !== null && targetUserIdInput !== undefined) {
      const target = await pool.query(
        "SELECT id FROM users WHERE telegram_id = $1 LIMIT 1",
        [targetUserIdInput]
      );
      targetUserId = target.rows[0]?.id ?? null;
    }

    const result = await pool.query(
      `INSERT INTO admin_audit_logs
        (admin_user_id, actor_telegram_id, action, target_user_id,
         currency, metadata, details)
       VALUES ($1, $2, $3, $4, 'USDT', $5::jsonb, $5::jsonb)
       RETURNING id, created_at`,
      [admin.rows[0].user_id, ctx.from.id, action, targetUserId, JSON.stringify(details)]
    );
    return { ok: result.rowCount === 1, id: result.rows[0]?.id };
  } catch (error) {
    console.error("[admin-ops] activity recording failed:", safeDiagnosticCode(error));
    return { ok: false, error: "Database operation failed (" + safeDiagnosticCode(error) + ")." };
  }
}

async function showDashboard(ctx, edit = false, showQueue = false) {
  const language = await getAdminLanguage(ctx);
  const [users, posts] = await Promise.all([
    pool.query(`
      SELECT COUNT(*)::int AS total,
             COUNT(*) FILTER (WHERE status = 'active')::int AS active,
             COUNT(*) FILTER (WHERE status <> 'active')::int AS other
      FROM users
    `),
    pool.query(`
      SELECT COUNT(*)::int AS total,
             COUNT(*) FILTER (WHERE status IN (
               'scheduled', 'preview_sending', 'preview_sent',
               'preview_unknown', 'approved', 'publishing', 'publish_unknown'
             ))::int AS pending,
             COUNT(*) FILTER (WHERE status = 'published')::int AS published,
             COUNT(*) FILTER (WHERE status = 'rejected')::int AS rejected
      FROM scheduled_posts
    `)
  ]);

  const u = users.rows[0];
  const p = posts.rows[0];
  const message = language === "fa"
    ? [
        "پروفینو — پنل مدیریت",
        "",
        "وضعیت کاربران",
        "تعداد کل: " + u.total,
        "فعال: " + u.active,
        "سایر وضعیت‌ها: " + u.other,
        "",
        "وضعیت پست‌ها",
        "تعداد کل: " + p.total,
        "در انتظار: " + p.pending,
        "منتشرشده: " + p.published,
        "ردشده: " + p.rejected,
        "",
        "مدیر ارشد: فقط مالک",
        "برای مشاهده اطلاعات کاربر از دستور /user <telegram_id> استفاده کنید."
      ].join("\n")
    : [
        "PROFINO — ADMIN OPERATIONS",
        "",
        "USER OVERVIEW",
        "Total: " + u.total,
        "Active: " + u.active,
        "Other statuses: " + u.other,
        "",
        "POST OVERVIEW",
        "Total: " + p.total,
        "Pending: " + p.pending,
        "Published: " + p.published,
        "Rejected: " + p.rejected,
        "",
        "Super Admin: Owner only",
        "Use /user <telegram_id> to inspect a user."
      ].join("\n");

  if (edit) {
    return ctx.editMessageText(message, { reply_markup: dashboardKeyboard(language, showQueue) });
  }
  return ctx.reply(message, { reply_markup: dashboardKeyboard(language, showQueue) });
}

async function showUsers(ctx, requestedPage, language) {
  const count = await pool.query("SELECT COUNT(*)::int AS total FROM users");
  const total = count.rows[0].total;
  const lastPage = Math.max(0, Math.ceil(total / PAGE_SIZE) - 1);
  const page = Math.min(requestedPage, lastPage);
  const offset = page * PAGE_SIZE;
  const result = await pool.query(
    `SELECT telegram_id, username, first_name, status
     FROM users
     ORDER BY created_at DESC, id DESC
     LIMIT $1 OFFSET $2`,
    [PAGE_SIZE, offset]
  );
  const keyboard = new InlineKeyboard();

  for (const user of result.rows) {
    const name = [user.first_name, user.username ? "@" + user.username : null]
      .filter(Boolean).join(" · ") || String(user.telegram_id);
    keyboard.text(
      (name + " — " + userStatusLabel(user.status, language)).slice(0, 60),
      "admin_user:" + user.telegram_id + userPageSuffix(page)
    ).row();
  }

  if (page > 0) keyboard.text(language === "fa" ? "← قبلی" : "← Previous", "admin_users:" + (page - 1));
  if (offset + result.rowCount < total) keyboard.text(language === "fa" ? "بعدی →" : "Next →", "admin_users:" + (page + 1));
  keyboard.row().text(language === "fa" ? "بازگشت" : "Back", "admin_home");

  const message = language === "fa"
    ? [
        "پروفینو — کاربران",
        "",
        result.rows.length
          ? result.rows.map(user =>
              "شناسه: " + user.telegram_id +
              " | " + (user.username ? "@" + user.username : (user.first_name || "بدون نام")) +
              " | " + userStatusLabel(user.status, language)
            ).join("\n")
          : "کاربری پیدا نشد.",
        "",
        "نمایش " + (total ? offset + 1 : 0) + " تا " + (offset + result.rowCount) + " از " + total,
        "جست‌وجو با شناسه تلگرام: /user <telegram_id>"
      ].join("\n")
    : [
        "PROFINO — USERS",
        "",
        result.rows.length
          ? result.rows.map(user =>
              "ID: " + user.telegram_id +
              " | " + (user.username ? "@" + user.username : (user.first_name || "No name")) +
              " | " + userStatusLabel(user.status, language)
            ).join("\n")
          : "No users found.",
        "",
        "Showing " + (total ? offset + 1 : 0) + "–" + (offset + result.rowCount) + " of " + total,
        "Search by Telegram ID: /user <telegram_id>"
      ].join("\n");

  return sendAdminScreen(ctx, message, keyboard, true);
}

function userPageSuffix(page) {
  return page > 0 ? ":" + page : "";
}

async function showUser(ctx, telegramId, edit = false, page = 0) {
  const language = await getAdminLanguage(ctx);
  const result = await pool.query(
    `SELECT id, telegram_id, username, first_name, last_name,
            status, referral_code, created_at
     FROM users WHERE telegram_id = $1`,
    [telegramId]
  );

  if (!result.rowCount) {
    const message = language === "fa" ? "کاربر پیدا نشد." : "User not found.";
    if (edit) {
      const keyboard = new InlineKeyboard().text(adminText(language, "Users", "کاربران"), "admin_users:" + page);
      return sendAdminScreen(ctx, message, keyboard, true);
    }
    return ctx.reply(message);
  }

  const user = result.rows[0];
  const message = language === "fa"
    ? [
        "پروفینو — جزئیات کاربر",
        "",
        "شناسه پایگاه داده: " + user.id,
        "شناسه تلگرام: " + user.telegram_id,
        "نام کاربری: " + (user.username ? "@" + user.username : "تنظیم نشده"),
        "نام: " + [user.first_name, user.last_name].filter(Boolean).join(" "),
        "وضعیت: " + userStatusLabel(user.status, language),
        "کد معرف: " + (user.referral_code || "—"),
        "تاریخ عضویت: " + formatDate(user.created_at, language),
        "",
        "تغییر وضعیت کاربر در گزارش فعالیت ثبت می‌شود."
      ].join("\n")
    : [
        "PROFINO — USER DETAILS",
        "",
        "Database ID: " + user.id,
        "Telegram ID: " + user.telegram_id,
        "Username: " + (user.username ? "@" + user.username : "Not set"),
        "Name: " + [user.first_name, user.last_name].filter(Boolean).join(" "),
        "Status: " + userStatusLabel(user.status, language),
        "Referral code: " + (user.referral_code || "—"),
        "Registered: " + formatDate(user.created_at, language),
        "",
        "User status changes are logged."
      ].join("\n");

  const keyboard = new InlineKeyboard();
  if (Number(user.telegram_id) !== SUPER_ADMIN_ID) {
    if (user.status === "active") {
      keyboard.text(language === "fa" ? "تعلیق کاربر" : "Suspend user", "admin_user_action:" + user.telegram_id + ":blocked" + userPageSuffix(page));
    } else {
      keyboard.text(language === "fa" ? "فعال‌سازی کاربر" : "Activate user", "admin_user_action:" + user.telegram_id + ":active" + userPageSuffix(page));
    }
  }
  keyboard.row().text(adminText(language, "Status history", "سابقه وضعیت"), "au:" + user.telegram_id + ":" + page);
  keyboard.row()
    .text(language === "fa" ? "کاربران" : "Users", "admin_users:" + page)
    .text(language === "fa" ? "داشبورد" : "Dashboard", "admin_home");

  return sendAdminScreen(ctx, message, keyboard, edit);
}

async function showPosts(ctx, edit = false) {
  const language = await getAdminLanguage(ctx);
  const result = await pool.query(`
    SELECT status, COUNT(*)::int AS total
    FROM scheduled_posts
    GROUP BY status
    ORDER BY status
  `);
  const lines = result.rows.map(row =>
    postStatusLabel(row.status, language) + ": " + row.total
  );
  const message = language === "fa"
    ? [
        "پروفینو — عملیات انتشار",
        "",
        lines.length ? lines.join("\n") : "پستی پیدا نشد.",
        "",
        "انتشار هر پست به تأیید دستی جدید نیاز دارد."
      ].join("\n")
    : [
        "PROFINO — POST OPERATIONS",
        "",
        lines.length ? lines.join("\n") : "No posts found.",
        "",
        "Publication always requires a fresh manual approval."
      ].join("\n");
  const keyboard = new InlineKeyboard()
    .text(language === "fa" ? "تاریخچه انتشار" : "Post history", "admin_posthistory")
    .row()
    .text(language === "fa" ? "بازگشت" : "Back", "admin_home");
  if (edit) return ctx.editMessageText(message, { reply_markup: keyboard });
  return ctx.reply(message, { reply_markup: keyboard });
}

function auditActionLabel(action, language) {
  const labels = {
    user_blocked: ["User suspended", "کاربر تعلیق شد"],
    user_activated: ["User activated", "کاربر فعال شد"],
    admin_dashboard_opened: ["Dashboard opened", "داشبورد باز شد"],
    admin_user_lookup: ["User details opened", "جزئیات کاربر باز شد"],
    admin_user_search: ["User search", "جست‌وجوی کاربر"],
    admin_activity_viewed: ["Activity viewed", "گزارش فعالیت مشاهده شد"]
  };
  return Object.hasOwn(labels, action) ? adminText(language, ...labels[action]) : action.toUpperCase();
}

async function showAuditLog(ctx, beforeId = null, statusOnly = false, target = null, page = 0) {
  const language = await getAdminLanguage(ctx);
  const result = await pool.query(
    `SELECT a.id, a.action, a.target_user_id, u.telegram_id AS target_telegram_id,
            a.details, a.created_at
     FROM admin_audit_logs a
     LEFT JOIN users u ON u.id = a.target_user_id
     WHERE ($1::numeric IS NULL OR a.id < least($1::numeric, 9223372036854775807)::bigint)
       AND (NOT $2::boolean OR a.action IN ('user_blocked', 'user_activated'))
       AND ($3::numeric IS NULL OR u.telegram_id = $3::numeric)
     ORDER BY a.id DESC
     LIMIT 11`, [beforeId, statusOnly, target]
  );
  const rows = result.rows.slice(0, 10);
  const lines = rows.map(row =>
    formatDate(row.created_at, language) + "\n" +
    auditActionLabel(row.action, language) +
    (row.target_telegram_id
      ? (language === "fa" ? " | شناسه تلگرام: " : " | Telegram: ") + row.target_telegram_id
      : "") +
    (row.details?.old_status && row.details?.new_status
      ? " | " + userStatusLabel(row.details.old_status, language) + " → " + userStatusLabel(row.details.new_status, language)
      : row.details?.new_status
      ? (language === "fa" ? " | وضعیت جدید: " : " | New status: ") + userStatusLabel(row.details.new_status, language)
      : "")
  );
  const message = language === "fa"
    ? [
        statusOnly ? "پروفینو — تغییرات وضعیت کاربران" : "پروفینو — گزارش فعالیت مدیر",
        "",
        lines.length ? lines.join("\n\n") : beforeId ? "رویداد قدیمی‌تری پیدا نشد." : statusOnly ? "هنوز تغییر وضعیتی ثبت نشده است." : "هنوز فعالیت مدیریتی ثبت نشده است."
      ].join("\n")
    : [
        statusOnly ? "PROFINO — USER STATUS CHANGES" : "PROFINO — ADMIN ACTIVITY AUDIT",
        "",
        lines.length ? lines.join("\n\n") : beforeId ? "No older activity found." : statusOnly ? "No user status changes recorded yet." : "No admin activity recorded yet."
      ].join("\n");
  const keyboard = new InlineKeyboard();
  const feed = target ? "au:" + target + ":" + page : statusOnly ? "admin_logs_status" : "admin_logs";
  if (result.rows.length > rows.length) {
    keyboard.text(adminText(language, "Older activity", "فعالیت‌های قدیمی‌تر"), feed + ":" + rows.at(-1).id).row();
  }
  if (beforeId) keyboard.text(adminText(language, "Latest activity", "آخرین فعالیت‌ها"), (target ? feed : feed + "_latest")).row();
  if (target) keyboard.text(adminText(language, "User details", "جزئیات کاربر"), "admin_user:" + target + userPageSuffix(page)).row();
  else if (statusOnly) keyboard.text(adminText(language, "All activity", "همه فعالیت‌ها"), "admin_logs_latest").row();
  else keyboard.text(adminText(language, "User status changes", "تغییرات وضعیت کاربران"), "admin_logs_status").row();
  keyboard.text(language === "fa" ? "بازگشت" : "Back", "admin_home");
  const heading = target ? adminText(language, "Telegram ID: ", "شناسه تلگرام: ") + target + "\n\n" : "";
  return sendAdminScreen(ctx, heading + message, keyboard, Boolean(ctx.callbackQuery && ctx.callbackQuery.data !== "admin_logs"));
}

async function confirmUserStatus(ctx, telegramId, newStatus, page) {
  const language = await getAdminLanguage(ctx);
  const result = await pool.query(
    "SELECT telegram_id, status FROM users WHERE telegram_id = $1",
    [telegramId]
  );
  if (!result.rowCount || Number(telegramId) === SUPER_ADMIN_ID) {
    return ctx.answerCallbackQuery({
      text: language === "fa" ? "کاربر در دسترس نیست." : "User unavailable.",
      show_alert: true
    });
  }

  const current = result.rows[0];
  if (current.status === newStatus) {
    return ctx.answerCallbackQuery({
      text: language === "fa" ? "نیازی به تغییر وضعیت نیست." : "No status change is needed."
    });
  }

  const action = newStatus === "active" ? "activate" : "suspend";
  const keyboard = new InlineKeyboard()
    .text(language === "fa" ? "تأیید" : "Confirm", "admin_user_confirm:" + telegramId + ":" + newStatus + ":" + current.status + userPageSuffix(page))
    .text(language === "fa" ? "انصراف" : "Cancel", "admin_user:" + telegramId + userPageSuffix(page));

  await ctx.answerCallbackQuery();
  const message = language === "fa"
    ? [
        "تأیید " + (newStatus === "active" ? "فعال‌سازی" : "تعلیق") + " کاربر",
        "",
        "شناسه تلگرام: " + telegramId,
        "وضعیت فعلی: " + userStatusLabel(current.status, language),
        "وضعیت جدید: " + userStatusLabel(newStatus, language),
        "",
        "این عملیات هیچ وجهی را جابه‌جا یا تغییر نمی‌دهد."
      ].join("\n")
    : [
        "CONFIRM USER " + action.toUpperCase(),
        "",
        "Telegram ID: " + telegramId,
        "Current status: " + userStatusLabel(current.status, language),
        "New status: " + newStatus.toUpperCase(),
        "",
        "This does not move or alter funds."
      ].join("\n");
  await sendAdminScreen(ctx, message, keyboard, true);
}

async function applyUserStatus(ctx, telegramId, newStatus, expectedStatus, page) {
  const language = await getAdminLanguage(ctx);
  if (Number(telegramId) === SUPER_ADMIN_ID) {
    return ctx.answerCallbackQuery({
      text: language === "fa" ? "وضعیت مدیر ارشد قابل تغییر نیست." : "The Super Admin cannot be changed.",
      show_alert: true
    });
  }

  const changed = await commitUserStatus(telegramId, newStatus, expectedStatus);
  if (!changed) {
    return ctx.answerCallbackQuery({
      text: adminText(language, "This confirmation is outdated. Reopen the user details and try again.",
        "این تأیید منقضی شده است. جزئیات کاربر را دوباره باز کنید و تلاش کنید."),
      show_alert: true
    });
  }

  try {
    await ctx.answerCallbackQuery({ text: adminText(language, "User status updated.", "وضعیت کاربر به‌روزرسانی شد.") });
  } catch (error) {
    console.error("[admin-ops] status acknowledgement failed:", safeDiagnosticCode(error));
  }
  try {
    await showUser(ctx, telegramId, true, page);
  } catch (error) {
    console.error("[admin-ops] updated user details unavailable:", safeDiagnosticCode(error));
    await ctx.reply(adminText(language, "Status updated. Reopen the user details to refresh.",
      "وضعیت به‌روزرسانی شد. برای مشاهدهٔ نتیجه، جزئیات کاربر را دوباره باز کنید.")).catch(error => {
      console.error("[admin-ops] status notification failed:", safeDiagnosticCode(error));
    });
  }
}

async function commitUserStatus(telegramId, newStatus, expectedStatus) {
  const client = await pool.connect();
  let transactionOpen = false;
  let releaseError = null;
  try {
    await client.query("BEGIN");
    transactionOpen = true;
    const locked = await client.query(
      "SELECT id, status FROM users WHERE telegram_id = $1 FOR UPDATE",
      [telegramId]
    );

    if (!locked.rowCount ||
        !isConfirmationCurrent(locked.rows[0].status, expectedStatus, newStatus)) {
      await client.query("ROLLBACK");
      transactionOpen = false;
      return false;
    }

    const admin = await client.query(
      `SELECT au.user_id
       FROM admin_users au
       JOIN users u ON u.id = au.user_id
       WHERE u.telegram_id = $1 AND au.role = 'owner' AND au.status = 'active'
       LIMIT 1`,
      [SUPER_ADMIN_ID]
    );
    if (!admin.rowCount) {
      throw new Error("No active admin_users record is linked to the Super Admin.");
    }

    const oldStatus = locked.rows[0].status;
    const updated = await client.query(
      "UPDATE users SET status = $1 WHERE telegram_id = $2 AND status = $3 RETURNING id, telegram_id, status",
      [newStatus, telegramId, expectedStatus]
    );
    if (updated.rowCount !== 1) {
      throw new Error("User status update did not affect exactly one row.");
    }
    const auditDetails = JSON.stringify({ old_status: oldStatus, new_status: newStatus });

    await client.query(
      `INSERT INTO admin_audit_logs
        (admin_user_id, actor_telegram_id, action, target_user_id,
         currency, metadata, details)
       VALUES ($1, $2, $3, $4, 'USDT', $5::jsonb, $5::jsonb)`,
      [
        admin.rows[0].user_id,
        SUPER_ADMIN_ID,
        newStatus === "active" ? "user_activated" : "user_blocked",
        updated.rows[0].id,
        auditDetails
      ]
    );
    await client.query("COMMIT");
    transactionOpen = false;
    return true;
  } catch (error) {
    if (transactionOpen) {
      releaseError = await rollbackTransaction(client, error);
      transactionOpen = false;
    }
    throw error;
  } finally {
    client.release(releaseError);
  }
}

export async function ensureAdminOpsSchema() {
  // Per-admin UI preference. This is additive and does not touch financial records.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS admin_preferences (
      user_id BIGINT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      language VARCHAR(2) NOT NULL DEFAULT 'en'
        CHECK (language IN ('en', 'fa')),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS admin_audit_logs (
      id BIGSERIAL PRIMARY KEY,
      actor_telegram_id BIGINT NOT NULL,
      action VARCHAR(60) NOT NULL,
      target_user_id BIGINT,
      details JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  // Upgrade legacy audit tables without deleting or rewriting existing rows.
  // Historical rows may not have an identifiable actor, so this column stays nullable.
  // Older installations may require admin_user_id; keep it populated for
  // compatibility while actor_telegram_id is the current canonical field.
  await pool.query(`
    ALTER TABLE admin_audit_logs
    ADD COLUMN IF NOT EXISTS admin_user_id BIGINT
  `);

  await pool.query(`
    ALTER TABLE admin_audit_logs
    ADD COLUMN IF NOT EXISTS actor_telegram_id BIGINT
  `);

  await pool.query(`
    ALTER TABLE admin_audit_logs
    ADD COLUMN IF NOT EXISTS details JSONB NOT NULL DEFAULT '{}'::jsonb
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_admin_audit_logs_created
    ON admin_audit_logs(id DESC)
  `);
}

async function showAdminLanguage(ctx, language, edit = false) {
  const keyboard = new InlineKeyboard()
    .text((language === "en" ? "✓ " : "") + "English", "admin_language_set:en")
    .text((language === "fa" ? "✓ " : "") + "فارسی", "admin_language_set:fa")
    .row()
    .text(language === "fa" ? "بازگشت" : "Back", "admin_home");
  const message = language === "fa"
    ? "تنظیم زبان پنل مدیریت\n\nزبان موردنظر را انتخاب کنید. این تنظیم فقط روی پنل خصوصی ادمین اثر دارد؛ رابط کاربران PROFINO انگلیسی باقی می‌ماند."
    : "ADMIN PANEL LANGUAGE\n\nChoose the language for the private admin panel. This preference does not change the customer-facing PROFINO interface, which remains English.";
  return sendAdminScreen(ctx, message, keyboard, edit);
}

async function sendAdminScreen(ctx, message, keyboard, edit) {
  if (edit) {
    try {
      return await ctx.editMessageText(message, { reply_markup: keyboard });
    } catch (error) {
      if (error.error_code === 400 && /message is not modified/i.test(error.description || "")) return;
      console.error("[admin-ops] admin screen edit failed:", safeDiagnosticCode(error));
    }
  }
  return ctx.reply(message, { reply_markup: keyboard });
}

export function registerAdminOps(bot, { inspectTestQueue, testWithdrawalReview } = {}) {
  if (testWithdrawalReview) {
    async function showReview(ctx, id, afterId = "0") {
      const edit = Boolean(ctx.callbackQuery);
      if (!isSuperAdminPrivate(ctx)) {
        return edit ? ctx.answerCallbackQuery({ text: "Unauthorized.", show_alert: true }) : ctx.reply("Access denied.");
      }
      if (edit) await ctx.answerCallbackQuery();
      const language = await getAdminLanguage(ctx);
      const label = (en, fa) => adminText(language, en, fa);
      const keyboard = new InlineKeyboard();
      try {
        if (!id) {
          const page = await testWithdrawalReview.list(ctx.from.id, afterId);
          for (const hold of page.holds) {
            keyboard.text("#" + hold.id + " · " + hold.amount + " USDT", "admin_sim_inspect:" + hold.id).row();
          }
          if (page.next) keyboard.text(label("Next", "بعدی"), "admin_sim_holds:" + page.next).row();
          if (afterId !== "0") keyboard.text(label("First page", "صفحه اول"), "admin_sim_holds:0").row();
          keyboard.text(label("Dashboard", "داشبورد"), "admin_home");
          const title = page.holds.length ? label("Select a reserved test withdrawal", "برداشت آزمایشی رزروشده را انتخاب کنید")
            : label("No reviewable test withdrawals on this page.", "در این صفحه برداشت آزمایشی قابل بازبینی وجود ندارد.");
          return sendAdminScreen(ctx, title, keyboard, edit);
        }
        if (!/^[1-9]\d{0,18}$/.test(id)) return ctx.reply(label("Usage: /reviewhold [id]", "روش استفاده: /reviewhold [id]"));
        const hold = await testWithdrawalReview.inspect(ctx.from.id, id);
        let message;
        if (!hold) {
          message = label("No reviewable test withdrawal found.", "برداشت آزمایشی قابل بازبینی پیدا نشد.");
        } else if (hold.status === "reserved") {
          keyboard.text(label("Confirm release", "تأیید آزادسازی"), "admin_sim_release:" + id).row();
          message = label("Release test withdrawal #", "آزادسازی برداشت آزمایشی شماره ") + id + "\n" +
            label("Amount returned to the customer's wallet: ", "مبلغ بازگشتی به کیف پول کاربر: ") + hold.amount + " USDT";
        } else if (hold.status === "cancelled" && hold.journal_id) {
          const actor = hold.cancelled_by_reviewer === null ? label("Customer", "صاحب حساب") :
            label("Reviewer #", "بازبین شماره ") + hold.cancelled_by_reviewer;
          message = [
            label("Closed test withdrawal #", "برداشت آزمایشی بسته‌شده شماره ") + id,
            label("Request amount: ", "مبلغ درخواست: ") + hold.amount + " USDT",
            label("Cancelled by: ", "لغوکننده: ") + actor,
            label("Release journal #", "سند آزادسازی شماره ") + hold.journal_id,
            label("Journal time: ", "زمان ثبت سند: ") + hold.released_at.toISOString()
          ].join("\n");
        } else {
          message = label("Release record unavailable. Check reconciliation.", "سند آزادسازی در دسترس نیست. تطبیق دفترکل را بررسی کنید.");
        }
        keyboard.text(label("Open requests", "درخواست‌های باز"), "admin_sim_holds:0");
        return sendAdminScreen(ctx, message, keyboard, edit);
      } catch (error) {
        console.error("[admin-ops] simulated withdrawal review failed:", safeDiagnosticCode(error));
        return ctx.reply(label("Unable to read test withdrawals.", "خواندن برداشت‌های آزمایشی ممکن نشد."));
      }
    }
    bot.command("reviewhold", ctx => showReview(ctx, ctx.match.trim()));
    bot.callbackQuery(/^admin_sim_holds:(\d{1,19})$/, ctx => showReview(ctx, null, ctx.match[1]));
    bot.callbackQuery(/^admin_sim_inspect:([1-9]\d{0,18})$/, ctx => showReview(ctx, ctx.match[1]));
    bot.callbackQuery(/^admin_sim_release:([1-9]\d{0,18})$/, async ctx => {
      if (!isSuperAdminPrivate(ctx)) return ctx.answerCallbackQuery({ text: "Unauthorized.", show_alert: true });
      await ctx.answerCallbackQuery();
      const language = await getAdminLanguage(ctx);
      const id = ctx.match[1];
      let journal;
      try {
        journal = await testWithdrawalReview.release(ctx.from.id, id);
      } catch (error) {
        console.error("[admin-ops] simulated release failed:", safeDiagnosticCode(error));
        return ctx.reply(adminText(language, "Unable to confirm this release.", "تأیید آزادسازی ممکن نشد."));
      }
      return sendAdminScreen(ctx, adminText(language, "Test withdrawal #", "برداشت آزمایشی شماره ") + id +
        adminText(language, " · release journal #", " · سند آزادسازی شماره ") + journal,
        new InlineKeyboard().text(adminText(language, "View receipt", "مشاهده رسید"), "admin_sim_inspect:" + id)
          .row().text(adminText(language, "Open requests", "درخواست‌های باز"), "admin_sim_holds:0"), true);
    });
  }

  if (inspectTestQueue) {
    async function showQueue(ctx) {
      if (!isSuperAdminPrivate(ctx)) {
        if (ctx.callbackQuery) return ctx.answerCallbackQuery({ text: "Unauthorized.", show_alert: true });
        return ctx.reply("Access denied.");
      }
      if (ctx.callbackQuery) await ctx.answerCallbackQuery();
      const language = await getAdminLanguage(ctx);
      const label = (en, fa) => adminText(language, en, fa);
      const keyboard = new InlineKeyboard();
      let queue;
      try {
        queue = await inspectTestQueue();
      } catch (error) {
        console.error("[admin-ops] simulation queue failed:", safeDiagnosticCode(error));
        keyboard.text(label("Retry", "تلاش دوباره"), "admin_simqueue")
          .text(label("Dashboard", "داشبورد"), "admin_home");
        return sendAdminScreen(ctx, label("Unable to read the simulation queue.", "خواندن صف آزمایشی ممکن نشد."),
          keyboard, Boolean(ctx.callbackQuery));
      }
      const lines = [
        label("Settlement simulation · test USDT", "شبیه‌سازی تسویه · تتر آزمایشی"),
        label("Due investments: ", "سرمایه‌گذاری‌های سررسیدشده: ") + queue.due_count,
        label("Reserve balance: ", "موجودی ذخیره: ") + queue.reserve_balance
      ];
      if (queue.first_id !== null) {
        lines.push(label("First investment: #", "اولین سرمایه‌گذاری: #") + queue.first_id,
          label("First settlement shortfall: ", "کسری اولین تسویه: ") + queue.first_shortfall,
          label("Total shortfall: ", "کسری کل صف: ") + queue.total_shortfall);
      }
      keyboard.text(label("Refresh", "به‌روزرسانی"), "admin_simqueue")
        .text(label("Dashboard", "داشبورد"), "admin_home");
      return sendAdminScreen(ctx, lines.join("\n"), keyboard, Boolean(ctx.callbackQuery));
    }
    bot.command("simqueue", showQueue);
    bot.callbackQuery("admin_simqueue", showQueue);
  }

  bot.command("planpreview", async ctx => {
    if (!isSuperAdminPrivate(ctx)) return ctx.reply("Access denied.");
    const language = await getAdminLanguage(ctx);
    const plan = previewSettlement(ctx.match);
    if (!plan) return ctx.reply(adminText(language,
      "Example: /planpreview SMART 25\nPlans: STARTER, SMART, PRO\nAmounts: 10, 25, 50, 75, 100 USDT",
      "نمونه: /planpreview SMART 25\nپلن‌ها: STARTER، SMART، PRO\nمبالغ: 10، 25، 50، 75، 100 USDT"));
    return ctx.reply(adminText(language, [
      "Settlement simulation · v1.0 · USDT",
      plan.name + " · " + plan.days + " days",
      "Principal: " + plan.amount,
      "Modelled profit (" + plan.profitPercent + "%): " + plan.profit,
      "Gross settlement: " + plan.gross,
      "Fee (" + plan.feePercent + "% of gross): " + plan.fee,
      "Net settlement: " + plan.payout
    ].join("\n"), [
      "شبیه‌سازی تسویه · نسخه ۱٫۰ · USDT",
      plan.name + " · " + plan.days + " روز",
      "اصل سرمایه: " + plan.amount,
      "سود محاسباتی (" + plan.profitPercent + "٪): " + plan.profit,
      "مبلغ ناخالص: " + plan.gross,
      "کارمزد (" + plan.feePercent + "٪ از ناخالص): " + plan.fee,
      "مبلغ خالص تسویه: " + plan.payout
    ].join("\n")));
  });

  bot.command("adminlanguage", async (ctx) => {
    if (!isSuperAdminPrivate(ctx)) return ctx.reply("Access denied.");
    const language = await getAdminLanguage(ctx);
    try {
      await showAdminLanguage(ctx, language);
    } catch (error) {
      console.error("[admin-ops] language settings failed:", safeDiagnosticCode(error));
      await ctx.reply(adminText(language, "Unable to load language settings.", "بارگذاری تنظیمات زبان ممکن نشد."));
    }
  });

  bot.callbackQuery(/^admin_language$/, async (ctx) => {
    if (!isSuperAdminPrivate(ctx)) return ctx.answerCallbackQuery({ text: "Unauthorized.", show_alert: true });
    const language = await getAdminLanguage(ctx);
    try {
      await ctx.answerCallbackQuery();
      await showAdminLanguage(ctx, language, true);
    } catch (error) {
      console.error("[admin-ops] language screen failed:", safeDiagnosticCode(error));
      await ctx.reply(adminText(language, "Unable to load language settings.", "بارگذاری تنظیمات زبان ممکن نشد."));
    }
  });

  bot.callbackQuery(/^admin_language_set:(en|fa)$/, async (ctx) => {
    if (!isSuperAdminPrivate(ctx)) return ctx.answerCallbackQuery({ text: "Unauthorized.", show_alert: true });
    const language = ctx.callbackQuery.data.split(":")[1];
    try {
      const result = await pool.query(
        `INSERT INTO admin_preferences (user_id, language, updated_at)
         SELECT id, $2, NOW() FROM users WHERE telegram_id = $1
         ON CONFLICT (user_id)
         DO UPDATE SET language = EXCLUDED.language, updated_at = NOW()
         RETURNING language`,
        [ctx.from.id, language]
      );
      if (!result.rowCount) {
        return ctx.answerCallbackQuery({ text: adminText(language, "Admin account is not registered.", "حساب مدیر ثبت نشده است."), show_alert: true });
      }
    } catch (error) {
      console.error("[admin-ops] language preference update failed:", safeDiagnosticCode(error));
      return ctx.answerCallbackQuery({ text: adminText(language, "Unable to save language preference.", "ذخیره تنظیم زبان ممکن نشد."), show_alert: true });
    }
    await ctx.answerCallbackQuery({ text: language === "fa" ? "زبان فارسی ذخیره شد." : "English preference saved." });
    await showAdminLanguage(ctx, language, true);
  });

  bot.command("admin", async (ctx) => {
    if (!isSuperAdminPrivate(ctx)) return ctx.reply("Access denied.");
    const language = await getAdminLanguage(ctx);
    await recordAdminActivity(ctx, "admin_dashboard_opened");
    try {
      await showDashboard(ctx, false, Boolean(inspectTestQueue));
    } catch (error) {
      console.error("[admin-ops] dashboard failed:", safeDiagnosticCode(error));
      await ctx.reply(adminText(language, "Unable to load the admin dashboard. Please try again.", "بارگذاری داشبورد مدیریت ممکن نشد. دوباره تلاش کنید."));
    }
  });

  bot.command("adminstats", async (ctx) => {
    if (!isSuperAdminPrivate(ctx)) return ctx.reply("Access denied.");
    const language = await getAdminLanguage(ctx);
    try { await showDashboard(ctx, false, Boolean(inspectTestQueue)); }
    catch (error) {
      console.error("[admin-ops] stats failed:", safeDiagnosticCode(error));
      await ctx.reply(adminText(language, "Unable to load admin statistics.", "بارگذاری آمار مدیریت ممکن نشد."));
    }
  });

  bot.command("user", async (ctx) => {
    if (!isSuperAdminPrivate(ctx)) return ctx.reply("Access denied.");
    const language = await getAdminLanguage(ctx);
    const telegramId = ctx.match?.trim();
    if (!/^\d{5,20}$/.test(telegramId || "")) {
      return ctx.reply(adminText(language, "Usage: /user <telegram_id>\nExample: /user 123456789", "نحوه استفاده: /user <telegram_id>\nنمونه: /user 123456789"));
    }
    await recordAdminActivity(ctx, "admin_user_lookup", telegramId);
    try { await showUser(ctx, telegramId); }
    catch (error) {
      console.error("[admin-ops] user lookup failed:", safeDiagnosticCode(error));
      await ctx.reply(adminText(language, "Unable to load this user.", "بارگذاری اطلاعات این کاربر ممکن نشد."));
    }
  });

  bot.command("usersearch", async (ctx) => {
    if (!isSuperAdminPrivate(ctx)) return ctx.reply("Access denied.");
    const language = await getAdminLanguage(ctx);
    const term = ctx.match?.trim().replace(/^@/, "");
    if (!term || term.length > 80) {
      return ctx.reply(language === "fa"
        ? "روش استفاده: /usersearch <شناسه تلگرام، نام کاربری یا نام>"
        : "Usage: /usersearch <Telegram ID, username, or name>");
    }

    await recordAdminActivity(ctx, "admin_user_search", null, { query: term });
    try {
      const result = await pool.query(
        `SELECT telegram_id, username, first_name, last_name, status
         FROM users
         WHERE telegram_id::text = $1
            OR strpos(lower(username), lower($1)) > 0
            OR strpos(lower(first_name), lower($1)) > 0
            OR strpos(lower(last_name), lower($1)) > 0
         ORDER BY created_at DESC, id DESC
         LIMIT 10`,
        [term]
      );

      if (!result.rowCount) {
        return ctx.reply(language === "fa" ? "کاربر منطبقی پیدا نشد." : "No matching users found.");
      }

      const keyboard = new InlineKeyboard();
      const lines = result.rows.map(user => {
        const name = [user.first_name, user.last_name].filter(Boolean).join(" ") ||
          (user.username ? "@" + user.username : (language === "fa" ? "بدون نام" : "No name"));
        keyboard.text(
          (name + " — " + userStatusLabel(user.status, language)).slice(0, 60),
          "admin_user:" + user.telegram_id
        ).row();
        return (language === "fa" ? "شناسه: " : "ID: ") + user.telegram_id + " | " +
          (user.username ? "@" + user.username : name) +
          " | " + userStatusLabel(user.status, language);
      });

      keyboard.text(language === "fa" ? "بازگشت" : "Back", "admin_home");
      const message = language === "fa"
        ? "پروفینو — جست‌وجوی کاربران\n\n" + lines.join("\n") + "\n\nحداکثر ۱۰ نتیجه نمایش داده می‌شود."
        : "PROFINO — USER SEARCH\n\n" + lines.join("\n") + "\n\nShowing up to 10 matches.";
      return ctx.reply(message, { reply_markup: keyboard });
    } catch (error) {
      console.error("[admin-ops] user search failed:", safeDiagnosticCode(error));
      return ctx.reply(language === "fa"
        ? "در حال حاضر جست‌وجوی کاربران ممکن نیست."
        : "Unable to search users right now.");
    }
  });

  bot.command("adminschema", async (ctx) => {
    if (!isSuperAdminPrivate(ctx)) return ctx.reply("Access denied.");
    const language = await getAdminLanguage(ctx);
    try {
      const result = await pool.query(`
        SELECT c.column_name, c.data_type, c.is_nullable,
               tc.constraint_type,
               ccu.table_name AS referenced_table,
               ccu.column_name AS referenced_column
        FROM information_schema.columns c
        LEFT JOIN information_schema.key_column_usage kcu
          ON kcu.table_schema = c.table_schema
         AND kcu.table_name = c.table_name
         AND kcu.column_name = c.column_name
        LEFT JOIN information_schema.table_constraints tc
          ON tc.constraint_schema = kcu.constraint_schema
         AND tc.constraint_name = kcu.constraint_name
        LEFT JOIN information_schema.constraint_column_usage ccu
          ON ccu.constraint_schema = tc.constraint_schema
         AND ccu.constraint_name = tc.constraint_name
        WHERE c.table_schema = current_schema()
          AND c.table_name = 'admin_audit_logs'
        ORDER BY c.ordinal_position
      `);
      const lines = result.rows.map(row =>
        row.column_name + " | " + row.data_type +
        " | nullable: " + row.is_nullable +
        (row.constraint_type ? " | " + row.constraint_type : "") +
        (row.referenced_table ? " -> " + row.referenced_table + "." + row.referenced_column : "")
      );
      const adminColumns = await pool.query(`
        SELECT c.column_name, c.data_type, c.is_nullable,
               c.column_default, tc.constraint_type,
               ccu.table_name AS referenced_table,
               ccu.column_name AS referenced_column
        FROM information_schema.columns c
        LEFT JOIN information_schema.key_column_usage kcu
          ON kcu.table_schema = c.table_schema
         AND kcu.table_name = c.table_name
         AND kcu.column_name = c.column_name
        LEFT JOIN information_schema.table_constraints tc
          ON tc.constraint_schema = kcu.constraint_schema
         AND tc.constraint_name = kcu.constraint_name
        LEFT JOIN information_schema.constraint_column_usage ccu
          ON ccu.constraint_schema = tc.constraint_schema
         AND ccu.constraint_name = tc.constraint_name
        WHERE c.table_schema = current_schema()
          AND c.table_name = 'admin_users'
        ORDER BY c.ordinal_position
      `);
      const auditChecks = await pool.query(`
        SELECT conname, pg_get_constraintdef(oid) AS definition
        FROM pg_constraint
        WHERE conrelid = 'admin_audit_logs'::regclass
          AND contype = 'c'
        ORDER BY conname
      `);
      const membership = await pool.query(`
        SELECT u.id AS users_id, u.telegram_id,
               (au.user_id IS NOT NULL) AS admin_record_exists,
               au.role AS admin_role,
               au.status AS admin_status
        FROM users u
        LEFT JOIN admin_users au ON au.user_id = u.id
        WHERE u.telegram_id = $1
        LIMIT 1
      `, [ctx.from.id]);
      const adminLines = adminColumns.rows.map(row =>
        row.column_name + " | " + row.data_type +
        " | nullable: " + row.is_nullable +
        (row.column_default ? " | default: " + row.column_default : "") +
        (row.constraint_type ? " | " + row.constraint_type : "") +
        (row.referenced_table ? " -> " + row.referenced_table + "." + row.referenced_column : "")
      );
      const membershipLine = membership.rows.length
        ? "Super Admin users.id: " + membership.rows[0].users_id +
          " | admin_users record exists: " + membership.rows[0].admin_record_exists +
          " | role: " + (membership.rows[0].admin_role ?? "N/A") +
          " | status: " + (membership.rows[0].admin_status ?? "N/A") +
          " | active owner check: " + (
            membership.rows[0].admin_role === "owner" &&
            membership.rows[0].admin_status === "active"
              ? "PASS"
              : "NOT VERIFIED"
          )
        : "Super Admin Telegram account is not present in users table.";

      await ctx.reply(
        adminText(language, "PROFINO — ADMIN AUDIT SCHEMA\n\n", "پروفینو — ساختار ممیزی مدیریت\n\n") +
        (lines.length ? lines.join("\n") : "admin_audit_logs table not found.") +
        "\n\nADMIN_USERS TABLE SCHEMA\n" +
        (adminLines.length ? adminLines.join("\n") : "admin_users table not found.") +
        "\n\nADMIN MEMBERSHIP CHECK\n" + membershipLine +
        "\n\nADMIN AUDIT CHECK CONSTRAINTS\n" +
        (auditChecks.rows.length
          ? auditChecks.rows.map(row => row.conname + " | " + row.definition).join("\n")
          : "No CHECK constraints found.")
      );
    } catch (error) {
      console.error("[admin-ops] schema diagnostic failed:", safeDiagnosticCode(error));
      await ctx.reply(adminText(language, "Unable to inspect admin audit schema. Diagnostic: ", "بررسی ساختار ممیزی مدیریت ممکن نشد. جزئیات: ") +
        safeDiagnosticCode(error));
    }
  });

  bot.command("adminlogs", async (ctx) => {
    if (!isSuperAdminPrivate(ctx)) return ctx.reply("Access denied.");
    const language = await getAdminLanguage(ctx);
    const auditWrite = await recordAdminActivity(ctx, "admin_activity_viewed");
    if (!auditWrite.ok) {
      await ctx.reply(
        adminText(language, "AUDIT WRITE FAILED\nDiagnostic: ", "ثبت رویداد ممیزی ناموفق بود\nجزئیات: ") +
        String(auditWrite.error || "No audit row returned").slice(0, 500)
      );
    }
    try { await showAuditLog(ctx); }
    catch (error) {
      console.error("[admin-ops] audit log failed:", safeDiagnosticCode(error));
      await ctx.reply(
        adminText(language, "Unable to load admin activity.\nDiagnostic: ", "بارگذاری فعالیت‌های مدیریت ممکن نشد\nجزئیات: ") +
        safeDiagnosticCode(error)
      );
    }
  });

  bot.callbackQuery(/^admin_(home|refresh)$/, async (ctx) => {
    if (!isSuperAdminPrivate(ctx)) return ctx.answerCallbackQuery({ text: "Unauthorized.", show_alert: true });
    const language = await getAdminLanguage(ctx);
    try {
      await ctx.answerCallbackQuery();
      await showDashboard(ctx, true, Boolean(inspectTestQueue));
    } catch (error) {
      console.error("[admin-ops] dashboard refresh failed:", safeDiagnosticCode(error));
      await ctx.answerCallbackQuery({ text: adminText(language, "Unable to refresh.", "به‌روزرسانی ممکن نشد."), show_alert: true });
    }
  });

  bot.callbackQuery(/^admin_users:\d+$/, async (ctx) => {
    if (!isSuperAdminPrivate(ctx)) return ctx.answerCallbackQuery({ text: "Unauthorized.", show_alert: true });
    const language = await getAdminLanguage(ctx);
    try {
      const page = Number(ctx.callbackQuery.data.split(":")[1]);
      await ctx.answerCallbackQuery();
      await showUsers(ctx, page, language);
    } catch (error) {
      console.error("[admin-ops] users list failed:", safeDiagnosticCode(error));
      await ctx.reply(adminText(language, "Unable to load users.", "بارگذاری کاربران ممکن نشد."));
    }
  });

  bot.callbackQuery(/^admin_user:\d+(?::\d{1,9})?$/, async (ctx) => {
    if (!isSuperAdminPrivate(ctx)) return ctx.answerCallbackQuery({ text: "Unauthorized.", show_alert: true });
    const language = await getAdminLanguage(ctx);
    try {
      await ctx.answerCallbackQuery();
      const [, telegramId, page] = ctx.callbackQuery.data.split(":");
      await showUser(ctx, telegramId, true, Number(page || 0));
    } catch (error) {
      console.error("[admin-ops] user details failed:", safeDiagnosticCode(error));
      await ctx.reply(adminText(language, "Unable to load user.", "بارگذاری اطلاعات کاربر ممکن نشد."));
    }
  });

  bot.callbackQuery(/^admin_user_action:\d+:(active|blocked)(?::\d{1,9})?$/, async (ctx) => {
    if (!isSuperAdminPrivate(ctx)) return ctx.answerCallbackQuery({ text: "Unauthorized.", show_alert: true });
    const [, telegramId, status, page] = ctx.callbackQuery.data.split(":");
    try { await confirmUserStatus(ctx, telegramId, status, Number(page || 0)); }
    catch (error) {
      console.error("[admin-ops] status confirmation failed:", safeDiagnosticCode(error));
      const language = await getAdminLanguage(ctx);
      await ctx.answerCallbackQuery({
        text: language === "fa" ? "آماده‌سازی تغییر وضعیت ممکن نشد." : "Unable to prepare status change.",
        show_alert: true
      });
    }
  });

  bot.callbackQuery(/^admin_user_confirm:\d+:(active|blocked):(active|blocked|pending)(?::\d{1,9})?$/, async (ctx) => {
    if (!isSuperAdminPrivate(ctx)) return ctx.answerCallbackQuery({ text: "Unauthorized.", show_alert: true });
    const [, telegramId, status, expectedStatus, page] = ctx.callbackQuery.data.split(":");
    try { await applyUserStatus(ctx, telegramId, status, expectedStatus, Number(page || 0)); }
    catch (error) {
      console.error("[admin-ops] status update failed:", safeDiagnosticCode(error));
      const language = await getAdminLanguage(ctx);
      await ctx.answerCallbackQuery({
        text: language === "fa" ? "به‌روزرسانی وضعیت کاربر ممکن نشد." : "Unable to update user status.",
        show_alert: true
      });
    }
  });

  bot.callbackQuery(/^admin_posts$/, async (ctx) => {
    if (!isSuperAdminPrivate(ctx)) return ctx.answerCallbackQuery({ text: "Unauthorized.", show_alert: true });
    const language = await getAdminLanguage(ctx);
    try {
      await ctx.answerCallbackQuery();
      await showPosts(ctx, true);
    } catch (error) {
      console.error("[admin-ops] post overview failed:", safeDiagnosticCode(error));
      await ctx.answerCallbackQuery({ text: adminText(language, "Unable to load post overview.", "بارگذاری نمای کلی پست‌ها ممکن نشد."), show_alert: true });
    }
  });

  bot.callbackQuery(/^(?:admin_logs(_status)?(?:_latest|:([1-9]\d{0,18}))?|au:([1-9]\d{0,18}):(\d{1,9})(?::([1-9]\d{0,18}))?)$/, async (ctx) => {
    if (!isSuperAdminPrivate(ctx)) {
      return ctx.answerCallbackQuery({ text: "Unauthorized.", show_alert: true });
    }

    const language = await getAdminLanguage(ctx);

    // Acknowledge the button immediately so Telegram does not leave the
    // inline-button spinner running while the database query is in progress.
    await ctx.answerCallbackQuery();

    try {
      const [, statusFilter, auditCursor, target, page, userCursor] = ctx.match;
      await showAuditLog(ctx, userCursor ?? auditCursor, Boolean(statusFilter || target), target, Number(page || 0));
    } catch (error) {
      console.error("[admin-ops] activity view failed:", safeDiagnosticCode(error));

      // Do not answer the same callback query twice. If editing the dashboard
      // fails (or the audit query fails), send a visible fallback message.
      try {
        await ctx.reply(
          adminText(language, "Unable to load admin activity.\nDiagnostic: ", "بارگذاری فعالیت‌های مدیریت ممکن نشد\nجزئیات: ") +
          safeDiagnosticCode(error)
        );
      } catch (replyError) {
        console.error("[admin-ops] activity fallback reply failed:", safeDiagnosticCode(replyError));
      }
    }
  });

  bot.command("dbschema", async (ctx) => {
    if (!isSuperAdminPrivate(ctx)) return ctx.reply("Access denied.");
    const language = await getAdminLanguage(ctx);
    try {
      const snapshot = await inspectCoreSchema(pool);
      const sections = formatCoreSchema(snapshot);
      await ctx.reply(
        adminText(language, "PROFINO — CORE DATABASE SCHEMA\nRead-only inspection. No records or schema were changed.", "پروفینو — ساختار پایگاه داده اصلی\nاین بررسی فقط‌خواندنی است؛ هیچ داده یا ساختاری تغییر نکرد.")
      );
      for (const section of sections) {
        for (let offset = 0; offset < section.length; offset += 3500) {
          await ctx.reply(section.slice(offset, offset + 3500));
        }
      }
    } catch (error) {
      console.error("[admin-ops] core database schema inspection failed:", safeDiagnosticCode(error));
      await ctx.reply(
        adminText(language, "Unable to inspect the core database schema.\nDiagnostic: ", "بررسی ساختار پایگاه داده اصلی ممکن نشد.\nجزئیات: ") +
        safeDiagnosticCode(error)
      );
    }
  });
}
