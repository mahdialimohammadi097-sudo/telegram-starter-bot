
import { Keyboard } from "grammy"
import { randomBytes } from "node:crypto"
import { pool } from "./database.js"

const ADMIN_ID = 8810232463
const CHANNEL_USERNAME = "@PROFINO1"

const mainMenu = new Keyboard()
  .text("My Account").text("My Wallet").row()
  .text("Investment Plans").text("My Investments").row()
  .text("Deposit").text("Withdraw").row()
  .text("Daily Profits").text("Referral Program").row()
  .text("Transaction History").text("Support")
  .resized()

const backMenu = new Keyboard()
  .text("⬅ Main Menu")
  .resized()

async function getOrCreateUser(ctx) {
  const result = await pool.query(
    `INSERT INTO users
      (telegram_id, username, first_name, last_name, referral_code, status)
     VALUES ($1, $2, $3, $4, $5, 'active')
     ON CONFLICT (telegram_id)
     DO UPDATE SET
       username = EXCLUDED.username,
       first_name = EXCLUDED.first_name,
       last_name = EXCLUDED.last_name
     RETURNING id, telegram_id, username, first_name,
               last_name, referral_code, status, created_at`,
    [
      ctx.from.id,
      ctx.from.username ?? null,
      ctx.from.first_name ?? null,
      ctx.from.last_name ?? null,
      randomBytes(8).toString("hex")
    ]
  )

  return result.rows[0]
}

async function getWalletBalances(userId) {
  const result = await pool.query(
    `SELECT
       la.account_type,
       COALESCE(
         SUM(
           CASE
             WHEN le.entry_type = 'credit' THEN le.amount
             WHEN le.entry_type = 'debit' THEN -le.amount
             ELSE 0
           END
         ), 0
       ) AS balance
     FROM ledger_accounts la
     LEFT JOIN ledger_entries le
       ON le.account_id = la.id
      AND le.transaction_id IN (
        SELECT id
        FROM ledger_transactions
        WHERE status = 'posted'
      )
     WHERE la.user_id = $1
       AND la.currency = 'USDT'
     GROUP BY la.account_type
     ORDER BY la.account_type`,
    [userId]
  )

  const balances = {
    AVAILABLE: null,
    INVESTED: null,
    PROFIT: null
  }

  for (const row of result.rows) {
    if (Object.hasOwn(balances, row.account_type)) {
      balances[row.account_type] = row.balance
    }
  }

  if (Object.values(balances).some(value => value === null)) {
    throw new Error("Wallet accounts are incomplete")
  }

  return balances
}

export function registerCommands(bot) {
  bot.command("start", async (ctx) => {
    try {
      const user = await getOrCreateUser(ctx)

      if (user.status !== "active") {
        return ctx.reply(
          "Your account is not active. Please contact support."
        )
      }

      await ctx.reply(
        `Welcome to PROFINO, ${user.first_name ?? "User"}!\n\nYour account is ready. Use the buttons below to continue.`,
        { reply_markup: mainMenu }
      )
    } catch (error) {
      console.error("[registration] Failed:", error.message)
      await ctx.reply(
        "Unable to load your account. Please try again later."
      )
    }
  })

  bot.command("help", (ctx) =>
    ctx.reply("Use the menu buttons to navigate PROFINO.")
  )

  bot.command("id", (ctx) =>
    ctx.reply(`Your Telegram ID: ${ctx.from?.id ?? "Unknown"}`)
  )

  bot.command("admin", (ctx) => {
    if (ctx.from?.id !== ADMIN_ID) {
      return ctx.reply("Access denied.")
    }

    return ctx.reply(
      "PROFINO Admin Panel\n\nAdmin access confirmed."
    )
  })

  // Verify PROFINO channel connection
  bot.command("channelcheck", async (ctx) => {
    if (ctx.from?.id !== ADMIN_ID) {
      return ctx.reply("Access denied.")
    }

    try {
      const chat = await ctx.api.getChat(CHANNEL_USERNAME)
      const me = await ctx.api.getMe()
      const member = await ctx.api.getChatMember(chat.id, me.id)

      const isAdmin =
        member.status === "creator" ||
        (
          member.status === "administrator" &&
          member.can_post_messages === true
        )

      if (!isAdmin) {
        return ctx.reply(
          "Channel access found, but posting permission is not confirmed."
        )
      }

      return ctx.reply(
        "PROFINO CHANNEL CONNECTION\n\n" +
        "Channel: @PROFINO1\n" +
        "Bot status: Administrator\n" +
        "Posting permission: Confirmed\n\n" +
        "Connection test successful."
      )
    } catch (error) {
      console.error("[channel] Check failed:", error.message)

      return ctx.reply(
        "Channel connection failed. Please check the bot permissions."
      )
    }
  })

  bot.on("message:text", async (ctx) => {
    const choice = ctx.message.text

    if (choice === "⬅ Main Menu") {
      return ctx.reply("Main Menu", { reply_markup: mainMenu })
    }

    if (choice === "My Account") {
      try {
        const result = await pool.query(
          `SELECT id, telegram_id, username, first_name,
                  last_name, referral_code, status, created_at
           FROM users
           WHERE telegram_id = $1`,
          [ctx.from.id]
        )

        if (result.rowCount === 0) {
          return ctx.reply("Please send /start to register first.")
        }

        const account = result.rows[0]

        return ctx.reply(
          `MY ACCOUNT\n\n` +
          `Account ID: ${account.id}\n` +
          `Telegram ID: ${account.telegram_id}\n` +
          `Username: ${account.username ? "@" + account.username : "Not set"}\n` +
          `Name: ${account.first_name ?? ""} ${account.last_name ?? ""}\n` +
          `Status: ${account.status.toUpperCase()}\n` +
          `Referral Code: ${account.referral_code}\n` +
          `Joined: ${new Date(account.created_at).toLocaleDateString("en-GB")}`,
          { reply_markup: backMenu }
        )
      } catch (error) {
        console.error("[account] Failed:", error.message)
        return ctx.reply(
          "Unable to load account information. Please try again later."
        )
      }
    }

    if (choice === "My Wallet") {
      try {
        const userResult = await pool.query(
          `SELECT id FROM users WHERE telegram_id = $1`,
          [ctx.from.id]
        )

        if (userResult.rowCount === 0) {
          return ctx.reply("Please send /start to register first.")
        }

        const balances = await getWalletBalances(userResult.rows[0].id)

        const format = value =>
          Number(value).toFixed(8)

        return ctx.reply(
          `MY WALLET\n\n` +
          `Available Balance: ${format(balances.AVAILABLE)} USDT\n` +
          `Invested Balance: ${format(balances.INVESTED)} USDT\n` +
          `Recorded Profit: ${format(balances.PROFIT)} USDT\n\n` +
          `Balances reflect posted ledger transactions only.`,
          { reply_markup: backMenu }
        )
      } catch (error) {
        console.error("[wallet] Failed:", error.message)
        return ctx.reply(
          "Unable to load wallet balances. Please try again later.",
          { reply_markup: backMenu }
        )
      }
    }

    const sections = {
      "Investment Plans":
        "INVESTMENT PLANS\n\nAvailable plans will appear here after configuration and verification.",

      "My Investments":
        "MY INVESTMENTS\n\nYour active investments will appear here.",

      "Deposit":
        "DEPOSIT\n\nAutomatic deposit verification is not enabled yet. Do not send funds until an official deposit address is displayed.",

      "Withdraw":
        "WITHDRAW\n\nWithdrawal services are not enabled yet.",

      "Daily Profits":
        "DAILY PROFITS\n\nVerified profit records will appear here when available.",

      "Referral Program":
        "REFERRAL PROGRAM\n\nYour referral details will appear here.",

      "Transaction History":
        "TRANSACTION HISTORY\n\nYour transaction records will appear here.",

      "Support":
        "SUPPORT\n\nPlease contact our support team."
    }

    if (sections[choice]) {
      return ctx.reply(sections[choice], {
        reply_markup: backMenu
      })
    }
  })
      }
