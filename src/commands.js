
import { Keyboard } from "grammy"
import { randomBytes } from "node:crypto"
import { pool } from "./database.js"

const ADMIN_ID = 8810232463

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
  const telegramId = ctx.from.id

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
      telegramId,
      ctx.from.username ?? null,
      ctx.from.first_name ?? null,
      ctx.from.last_name ?? null,
      randomBytes(8).toString("hex")
    ]
  )

  return result.rows[0]
}

export function registerCommands(bot) {
  bot.command("start", async (ctx) => {
    try {
      const user = await getOrCreateUser(ctx)

      if (user.status !== "active") {
        return ctx.reply("Your account is not active. Please contact support.")
      }

      await ctx.reply(
        `Welcome to PROFINO, ${user.first_name ?? "User"}!\n\nYour account is ready. Use the buttons below to continue.`,
        { reply_markup: mainMenu }
      )
    } catch (error) {
      console.error("[registration] Failed:", error.message)
      await ctx.reply("Unable to load your account. Please try again later.")
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

    return ctx.reply("PROFINO Admin Panel\n\nAdmin access confirmed.")
  })

  bot.on("message:text", async (ctx) => {
    const choice = ctx.message.text

    if (choice === "⬅ Main Menu") {
      return ctx.reply("Main Menu", { reply_markup: mainMenu })
    }

    if (choice === "My Account") {
      try {
        const user = await pool.query(
          `SELECT id, telegram_id, username, first_name,
                  last_name, referral_code, status, created_at
           FROM users
           WHERE telegram_id = $1`,
          [ctx.from.id]
        )

        if (user.rowCount === 0) {
          return ctx.reply("Please send /start to register first.")
        }

        const account = user.rows[0]

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
        return ctx.reply("Unable to load account information. Please try again later.")
      }
    }

    const sections = {
      "My Wallet": "MY WALLET\n\nYour verified wallet balances will appear here.",
      "Investment Plans": "INVESTMENT PLANS\n\nAvailable plans will appear here after configuration and verification.",
      "My Investments": "MY INVESTMENTS\n\nYour active investments will appear here.",
      "Deposit": "DEPOSIT\n\nAutomatic deposit verification is not enabled yet. Do not send funds until an official deposit address is displayed.",
      "Withdraw": "WITHDRAW\n\nWithdrawal services are not enabled yet.",
      "Daily Profits": "DAILY PROFITS\n\nVerified profit records will appear here when available.",
      "Referral Program": "REFERRAL PROGRAM\n\nYour referral details will appear here.",
      "Transaction History": "TRANSACTION HISTORY\n\nYour transaction records will appear here.",
      "Support": "SUPPORT\n\nPlease contact our support team."
    }

    if (sections[choice]) {
      return ctx.reply(sections[choice], { reply_markup: backMenu })
    }
  })
                         }
