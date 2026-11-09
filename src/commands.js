
import { Keyboard } from "grammy"

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

export function registerCommands(bot) {
  bot.command("start", async (ctx) => {
    await ctx.reply(
      `Welcome to PROFINO, ${ctx.from?.first_name ?? "User"}!\n\nManage your account using the buttons below.`,
      { reply_markup: mainMenu }
    )
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

    switch (choice) {
      case "⬅ Main Menu":
        return ctx.reply("Main Menu", {
          reply_markup: mainMenu
        })

      case "My Account":
        return ctx.reply(
          "MY ACCOUNT\n\nYour account information will appear here once registration is connected.",
          { reply_markup: backMenu }
        )

      case "My Wallet":
        return ctx.reply(
          "MY WALLET\n\nWallet balances will appear here after account integration.",
          { reply_markup: backMenu }
        )

      case "Investment Plans":
        return ctx.reply(
          "INVESTMENT PLANS\n\nAvailable plans will be displayed here after configuration and verification.",
          { reply_markup: backMenu }
        )

      case "My Investments":
        return ctx.reply(
          "MY INVESTMENTS\n\nYour active investments will appear here.",
          { reply_markup: backMenu }
        )

      case "Deposit":
        return ctx.reply(
          "DEPOSIT\n\nAutomatic BEP20 deposit verification is not enabled yet.\n\nDo not send funds until an official deposit address is displayed.",
          { reply_markup: backMenu }
        )

      case "Withdraw":
        return ctx.reply(
          "WITHDRAW\n\nWithdrawal services are not enabled yet.",
          { reply_markup: backMenu }
        )

      case "Daily Profits":
        return ctx.reply(
          "DAILY PROFITS\n\nVerified profit records will appear here when available.",
          { reply_markup: backMenu }
        )

      case "Referral Program":
        return ctx.reply(
          "REFERRAL PROGRAM\n\nYour personal referral link and referral statistics will appear here.",
          { reply_markup: backMenu }
        )

      case "Transaction History":
        return ctx.reply(
          "TRANSACTION HISTORY\n\nYour deposits, withdrawals and other transactions will appear here.",
          { reply_markup: backMenu }
        )

      case "Support":
        return ctx.reply(
          "SUPPORT\n\nOur support section will be available here.",
          { reply_markup: backMenu }
        )
    }
  })
}
