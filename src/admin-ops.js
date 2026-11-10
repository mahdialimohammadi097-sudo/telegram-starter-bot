import { InlineKeyboard } from "grammy";
import { pool } from "./database.js";
import { isConfirmationCurrent } from "./admin-status-guard.js";
import { inspectCoreSchema, formatCoreSchema } from "./database-diagnostics.js";

const SUPER_ADMIN_ID = 8810232463;
const PAGE_SIZE = 8;

function isSuperAdminPrivate(ctx) {
  return ctx.from?.id === SUPER_ADMIN_ID && ctx.chat?.type === "private";
}

function formatDate(value) {
  if (!value) return "—";
  return new Date(value).toLocaleString("en-GB", {
    timeZone: "UTC",
    dateStyle: "medium",
    timeStyle: "short"
  }) + " UTC";
}

function dashboardKeyboard() {
  return new InlineKeyboard()
    .text("Overview / نمای کلی", "admin_home")
    .row()
    .text("Users / کاربران", "admin_users:0")
    .text("Posts / پست‌ها", "admin_posts")
    .row()
    .text("Activity / فعالیت‌ها", "admin_logs")
    .text("Refresh / بروزرسانی", "admin_refresh");
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
       WHERE u.telegram_id = $1 AND au.status = 'active'
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
    console.error("[admin-ops] activity recording failed:", error.message);
    return { ok: false, error: String(error?.message || error).slice(0, 500) };
  }
}

async function showDashboard(ctx, edit = false) {
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
  const message = [
    "PROFINO — ADMIN OPERATIONS",
    "پنل مدیریت و عملیات",
    "",
    "USER OVERVIEW / وضعیت کاربران",
    "Total / کل: " + u.total,
    "Active / فعال: " + u.active,
    "Other statuses / سایر وضعیت‌ها: " + u.other,
    "",
    "POST OVERVIEW / وضعیت پست‌ها",
    "Total / کل: " + p.total,
    "Pending / در انتظار: " + p.pending,
    "Published / منتشرشده: " + p.published,
    "Rejected / ردشده: " + p.rejected,
    "",
    "Super Admin / مدیر ارشد: Owner only",
    "Use /user <telegram_id> to inspect a user.",
    "برای بررسی کاربر از دستور /user <telegram_id> استفاده کنید."
  ].join("\n");

  if (edit) {
    return ctx.editMessageText(message, { reply_markup: dashboardKeyboard() });
  }
  return ctx.reply(message, { reply_markup: dashboardKeyboard() });
}

async function showUsers(ctx, page = 0, edit = false) {
  const offset = page * PAGE_SIZE;
  const result = await pool.query(
    `SELECT telegram_id, username, first_name, status
     FROM users
     ORDER BY created_at DESC, id DESC
     LIMIT $1 OFFSET $2`,
    [PAGE_SIZE, offset]
  );
  const count = await pool.query("SELECT COUNT(*)::int AS total FROM users");
  const total = count.rows[0].total;
  const keyboard = new InlineKeyboard();

  for (const user of result.rows) {
    const name = [user.first_name, user.username ? "@" + user.username : null]
      .filter(Boolean).join(" · ") || String(user.telegram_id);
    keyboard.text(
      (name + " — " + user.status.toUpperCase()).slice(0, 60),
      "admin_user:" + user.telegram_id
    ).row();
  }

  if (page > 0) keyboard.text("← Previous", "admin_users:" + (page - 1));
  if (offset + result.rowCount < total) keyboard.text("Next →", "admin_users:" + (page + 1));
  keyboard.row().text("Back / بازگشت", "admin_home");

  const message = [
    "PROFINO — USERS / کاربران",
    "",
    result.rows.length
      ? result.rows.map(user =>
          "ID: " + user.telegram_id +
          " | " + (user.username ? "@" + user.username : (user.first_name || "No name")) +
          " | " + user.status.toUpperCase()
        ).join("\n")
      : "No users found / کاربری یافت نشد",
    "",
    "Showing " + (total ? offset + 1 : 0) + "–" + (offset + result.rowCount) + " of " + total,
    "Search by Telegram ID: /user <telegram_id>"
  ].join("\n");

  if (edit) return ctx.editMessageText(message, { reply_markup: keyboard });
  return ctx.reply(message, { reply_markup: keyboard });
}

async function showUser(ctx, telegramId, edit = false) {
  const result = await pool.query(
    `SELECT id, telegram_id, username, first_name, last_name,
            status, referral_code, created_at
     FROM users WHERE telegram_id = $1`,
    [telegramId]
  );

  if (!result.rowCount) {
    const message = "User not found / کاربر پیدا نشد.";
    if (edit) return ctx.editMessageText(message, { reply_markup: dashboardKeyboard() });
    return ctx.reply(message);
  }

  const user = result.rows[0];
  const message = [
    "PROFINO — USER DETAILS",
    "جزئیات کاربر",
    "",
    "Database ID: " + user.id,
    "Telegram ID: " + user.telegram_id,
    "Username: " + (user.username ? "@" + user.username : "Not set"),
    "Name: " + [user.first_name, user.last_name].filter(Boolean).join(" "),
    "Status / وضعیت: " + user.status.toUpperCase(),
    "Referral code: " + (user.referral_code || "—"),
    "Registered / عضویت: " + formatDate(user.created_at),
    "",
    "User status changes are logged.",
    "تغییر وضعیت کاربر در گزارش فعالیت ثبت می‌شود."
  ].join("\n");

  const keyboard = new InlineKeyboard();
  if (Number(user.telegram_id) !== SUPER_ADMIN_ID) {
    if (user.status === "active") {
      keyboard.text("Suspend / تعلیق", "admin_user_action:" + user.telegram_id + ":blocked");
    } else {
      keyboard.text("Activate / فعال‌سازی", "admin_user_action:" + user.telegram_id + ":active");
    }
  }
  keyboard.row().text("Users / کاربران", "admin_users:0")
    .text("Dashboard / داشبورد", "admin_home");

  if (edit) return ctx.editMessageText(message, { reply_markup: keyboard });
  return ctx.reply(message, { reply_markup: keyboard });
}

async function showPosts(ctx, edit = false) {
  const result = await pool.query(`
    SELECT status, COUNT(*)::int AS total
    FROM scheduled_posts
    GROUP BY status
    ORDER BY status
  `);
  const lines = result.rows.map(row => row.status.toUpperCase() + ": " + row.total);
  const message = [
    "PROFINO — POST OPERATIONS",
    "عملیات پست‌ها",
    "",
    lines.length ? lines.join("\n") : "No posts found.",
    "",
    "Publication always requires a fresh manual approval.",
    "انتشار همیشه به تأیید دستی جدید نیاز دارد."
  ].join("\n");
  const keyboard = new InlineKeyboard()
    .text("Post History / تاریخچه پست‌ها", "admin_posthistory")
    .row()
    .text("Back / بازگشت", "admin_home");
  if (edit) return ctx.editMessageText(message, { reply_markup: keyboard });
  return ctx.reply(message, { reply_markup: keyboard });
}

async function showAuditLog(ctx, edit = false) {
  const result = await pool.query(
    `SELECT a.action, a.target_user_id, u.telegram_id AS target_telegram_id,
            a.details, a.created_at
     FROM admin_audit_logs a
     LEFT JOIN users u ON u.id = a.target_user_id
     ORDER BY a.id DESC
     LIMIT 10`
  );
  const lines = result.rows.map(row =>
    formatDate(row.created_at) + "\n" +
    row.action.toUpperCase() +
    (row.target_telegram_id ? " | Telegram: " + row.target_telegram_id : "") +
    (row.details?.new_status ? " | " + row.details.new_status.toUpperCase() : "")
  );
  const message = [
    "PROFINO — USER STATUS AUDIT",
    "گزارش تغییر وضعیت کاربران",
    "",
    lines.length ? lines.join("\n\n") : "No admin activity recorded yet."
  ].join("\n");
  const keyboard = new InlineKeyboard().text("Back / بازگشت", "admin_home");
  if (edit) return ctx.editMessageText(message, { reply_markup: keyboard });
  return ctx.reply(message, { reply_markup: keyboard });
}

async function confirmUserStatus(ctx, telegramId, newStatus) {
  const result = await pool.query(
    "SELECT telegram_id, status FROM users WHERE telegram_id = $1",
    [telegramId]
  );
  if (!result.rowCount || Number(telegramId) === SUPER_ADMIN_ID) {
    return ctx.answerCallbackQuery({ text: "User unavailable.", show_alert: true });
  }

  const current = result.rows[0];
  if (current.status === newStatus) {
    return ctx.answerCallbackQuery({ text: "No status change is needed." });
  }

  const action = newStatus === "active" ? "activate" : "suspend";
  const keyboard = new InlineKeyboard()
    .text("Confirm / تأیید", "admin_user_confirm:" + telegramId + ":" + newStatus + ":" + current.status)
    .text("Cancel / انصراف", "admin_user:" + telegramId);

  await ctx.answerCallbackQuery();
  await ctx.editMessageText(
    "CONFIRM USER " + action.toUpperCase() + "\n" +
    "تأیید " + (newStatus === "active" ? "فعال‌سازی" : "تعلیق") + " کاربر" +
    "\n\nTelegram ID: " + telegramId +
    "\nCurrent status: " + current.status.toUpperCase() +
    "\nNew status: " + newStatus.toUpperCase() +
    "\n\nThis does not move or alter funds.",
    { reply_markup: keyboard }
  );
}

async function applyUserStatus(ctx, telegramId, newStatus, expectedStatus) {
  if (Number(telegramId) === SUPER_ADMIN_ID) {
    return ctx.answerCallbackQuery({ text: "The Super Admin cannot be changed.", show_alert: true });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const locked = await client.query(
      "SELECT id, status FROM users WHERE telegram_id = $1 FOR UPDATE",
      [telegramId]
    );

    if (!locked.rowCount ||
        !isConfirmationCurrent(locked.rows[0].status, expectedStatus, newStatus)) {
      await client.query("ROLLBACK");
      await ctx.answerCallbackQuery({
        text: "This confirmation is outdated. Reopen the user details and try again.",
        show_alert: true
      });
      return;
    }

    const admin = await client.query(
      `SELECT au.user_id
       FROM admin_users au
       JOIN users u ON u.id = au.user_id
       WHERE u.telegram_id = $1 AND au.status = 'active'
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
    await ctx.answerCallbackQuery({ text: "User status updated." });
    await showUser(ctx, telegramId, true);
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

export async function ensureAdminOpsSchema() {
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

export function registerAdminOps(bot) {
  bot.command("admin", async (ctx) => {
    if (!isSuperAdminPrivate(ctx)) return ctx.reply("Access denied.");
    await recordAdminActivity(ctx, "admin_dashboard_opened");
    try {
      await showDashboard(ctx);
    } catch (error) {
      console.error("[admin-ops] dashboard failed:", error);
      await ctx.reply("Unable to load the admin dashboard. Please try again.");
    }
  });

  bot.command("adminstats", async (ctx) => {
    if (!isSuperAdminPrivate(ctx)) return ctx.reply("Access denied.");
    try { await showDashboard(ctx); }
    catch (error) {
      console.error("[admin-ops] stats failed:", error);
      await ctx.reply("Unable to load admin statistics.");
    }
  });

  bot.command("user", async (ctx) => {
    if (!isSuperAdminPrivate(ctx)) return ctx.reply("Access denied.");
    const telegramId = ctx.match?.trim();
    if (!/^\d{5,20}$/.test(telegramId || "")) {
      return ctx.reply("Usage: /user <telegram_id>\nExample: /user 123456789");
    }
    await recordAdminActivity(ctx, "admin_user_lookup", telegramId);
    try { await showUser(ctx, telegramId); }
    catch (error) {
      console.error("[admin-ops] user lookup failed:", error);
      await ctx.reply("Unable to load this user.");
    }
  });

  bot.command("usersearch", async (ctx) => {
    if (!isSuperAdminPrivate(ctx)) return ctx.reply("Access denied.");
    const term = ctx.match?.trim();
    if (!term || term.length > 80) {
      return ctx.reply("Usage: /usersearch <Telegram ID, username, or name>");
    }

    await recordAdminActivity(ctx, "admin_user_search", null, { query: term });
    try {
      const result = await pool.query(
        `SELECT telegram_id, username, first_name, last_name, status
         FROM users
         WHERE telegram_id::text = $1
            OR COALESCE(username, '') ILIKE '%' || $1 || '%'
            OR COALESCE(first_name, '') ILIKE '%' || $1 || '%'
            OR COALESCE(last_name, '') ILIKE '%' || $1 || '%'
         ORDER BY created_at DESC, id DESC
         LIMIT 10`,
        [term.replace(/^@/, "")]
      );

      if (!result.rowCount) return ctx.reply("No matching users found.");

      const keyboard = new InlineKeyboard();
      const lines = result.rows.map(user => {
        const name = [user.first_name, user.last_name].filter(Boolean).join(" ") ||
          (user.username ? "@" + user.username : "No name");
        keyboard.text(
          (name + " — " + user.status.toUpperCase()).slice(0, 60),
          "admin_user:" + user.telegram_id
        ).row();
        return "ID: " + user.telegram_id + " | " +
          (user.username ? "@" + user.username : name) +
          " | " + user.status.toUpperCase();
      });

      keyboard.text("Back / بازگشت", "admin_home");
      return ctx.reply(
        "PROFINO — USER SEARCH / جست‌وجوی کاربران\n\n" +
        lines.join("\n") + "\n\nShowing up to 10 matches.",
        { reply_markup: keyboard }
      );
    } catch (error) {
      console.error("[admin-ops] user search failed:", error);
      return ctx.reply("Unable to search users right now.");
    }
  });

  bot.command("adminschema", async (ctx) => {
    if (!isSuperAdminPrivate(ctx)) return ctx.reply("Access denied.");
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
               (au.user_id IS NOT NULL) AS admin_record_exists
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
          " | admin_users record exists: " + membership.rows[0].admin_record_exists
        : "Super Admin Telegram account is not present in users table.";

      await ctx.reply(
        "PROFINO — ADMIN AUDIT SCHEMA\n\n" +
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
      console.error("[admin-ops] schema diagnostic failed:", error);
      await ctx.reply("Unable to inspect admin audit schema. Diagnostic: " +
        String(error?.message || error).slice(0, 500));
    }
  });

  bot.command("adminlogs", async (ctx) => {
    if (!isSuperAdminPrivate(ctx)) return ctx.reply("Access denied.");
    const auditWrite = await recordAdminActivity(ctx, "admin_activity_viewed");
    if (!auditWrite.ok) {
      await ctx.reply(
        "AUDIT WRITE FAILED\nDiagnostic: " +
        String(auditWrite.error || "No audit row returned").slice(0, 500)
      );
    }
    try { await showAuditLog(ctx); }
    catch (error) {
      console.error("[admin-ops] audit log failed:", error);
      await ctx.reply(
        "Unable to load admin activity.\nDiagnostic: " +
        String(error?.message || error).slice(0, 700)
      );
    }
  });

  bot.callbackQuery(/^admin_(home|refresh)$/, async (ctx) => {
    if (!isSuperAdminPrivate(ctx)) return ctx.answerCallbackQuery({ text: "Unauthorized.", show_alert: true });
    try {
      await ctx.answerCallbackQuery();
      await showDashboard(ctx, true);
    } catch (error) {
      console.error("[admin-ops] dashboard refresh failed:", error);
      await ctx.answerCallbackQuery({ text: "Unable to refresh.", show_alert: true });
    }
  });

  bot.callbackQuery(/^admin_users:\d+$/, async (ctx) => {
    if (!isSuperAdminPrivate(ctx)) return ctx.answerCallbackQuery({ text: "Unauthorized.", show_alert: true });
    try {
      const page = Number(ctx.callbackQuery.data.split(":")[1]);
      await ctx.answerCallbackQuery();
      await showUsers(ctx, page, true);
    } catch (error) {
      console.error("[admin-ops] users list failed:", error);
      await ctx.answerCallbackQuery({ text: "Unable to load users.", show_alert: true });
    }
  });

  bot.callbackQuery(/^admin_user:\d+$/, async (ctx) => {
    if (!isSuperAdminPrivate(ctx)) return ctx.answerCallbackQuery({ text: "Unauthorized.", show_alert: true });
    try {
      await ctx.answerCallbackQuery();
      await showUser(ctx, ctx.callbackQuery.data.split(":")[1], true);
    } catch (error) {
      console.error("[admin-ops] user details failed:", error);
      await ctx.answerCallbackQuery({ text: "Unable to load user.", show_alert: true });
    }
  });

  bot.callbackQuery(/^admin_user_action:\d+:(active|blocked)$/, async (ctx) => {
    if (!isSuperAdminPrivate(ctx)) return ctx.answerCallbackQuery({ text: "Unauthorized.", show_alert: true });
    const [, telegramId, status] = ctx.callbackQuery.data.split(":");
    try { await confirmUserStatus(ctx, telegramId, status); }
    catch (error) {
      console.error("[admin-ops] status confirmation failed:", error);
      await ctx.answerCallbackQuery({ text: "Unable to prepare status change.", show_alert: true });
    }
  });

  bot.callbackQuery(/^admin_user_confirm:\d+:(active|blocked):(active|blocked|pending)$/, async (ctx) => {
    if (!isSuperAdminPrivate(ctx)) return ctx.answerCallbackQuery({ text: "Unauthorized.", show_alert: true });
    const [, telegramId, status, expectedStatus] = ctx.callbackQuery.data.split(":");
    try { await applyUserStatus(ctx, telegramId, status, expectedStatus); }
    catch (error) {
      console.error("[admin-ops] status update failed:", error);
      await ctx.answerCallbackQuery({ text: "Unable to update user status.", show_alert: true });
    }
  });

  bot.callbackQuery(/^admin_posts$/, async (ctx) => {
    if (!isSuperAdminPrivate(ctx)) return ctx.answerCallbackQuery({ text: "Unauthorized.", show_alert: true });
    try {
      await ctx.answerCallbackQuery();
      await showPosts(ctx, true);
    } catch (error) {
      console.error("[admin-ops] post overview failed:", error);
      await ctx.answerCallbackQuery({ text: "Unable to load post overview.", show_alert: true });
    }
  });

  bot.callbackQuery(/^admin_posthistory$/, async (ctx) => {
    if (!isSuperAdminPrivate(ctx)) return ctx.answerCallbackQuery({ text: "Unauthorized.", show_alert: true });
    await ctx.answerCallbackQuery();
    return ctx.reply("Use /posthistory to open the complete post history.");
  });

  bot.callbackQuery(/^admin_logs$/, async (ctx) => {
    if (!isSuperAdminPrivate(ctx)) {
      return ctx.answerCallbackQuery({ text: "Unauthorized.", show_alert: true });
    }

    // Acknowledge the button immediately so Telegram does not leave the
    // inline-button spinner running while the database query is in progress.
    await ctx.answerCallbackQuery();

    try {
      // Send the activity report as a new message rather than editing the
      // dashboard message; this avoids Telegram edit restrictions.
      await showAuditLog(ctx, false);
    } catch (error) {
      console.error("[admin-ops] activity view failed:", error);

      // Do not answer the same callback query twice. If editing the dashboard
      // fails (or the audit query fails), send a visible fallback message.
      try {
        await ctx.reply(
          "Unable to load admin activity.\nDiagnostic: " +
          String(error?.message || error).slice(0, 700)
        );
      } catch (replyError) {
        console.error("[admin-ops] activity fallback reply failed:", replyError);
      }
    }
  });

  bot.command("dbschema", async (ctx) => {
    if (!isSuperAdminPrivate(ctx)) return ctx.reply("Access denied.");
    try {
      const snapshot = await inspectCoreSchema(pool);
      const sections = formatCoreSchema(snapshot);
      await ctx.reply(
        "PROFINO — CORE DATABASE SCHEMA\n" +
        "Read-only inspection. No records or schema were changed."
      );
      for (const section of sections) {
        for (let offset = 0; offset < section.length; offset += 3500) {
          await ctx.reply(section.slice(offset, offset + 3500));
        }
      }
    } catch (error) {
      console.error("[admin-ops] core database schema inspection failed:", error);
      await ctx.reply(
        "Unable to inspect the core database schema.\nDiagnostic: " +
        String(error?.message || error).slice(0, 500)
      );
    }
  });
}
