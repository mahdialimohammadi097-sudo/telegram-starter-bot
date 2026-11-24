import pg from "pg";
import { reserveWithdrawal, cancelWithdrawal } from "../test-support/simulated-withdrawal.js";
import { getWalletBalances } from "./wallet-balances.js";
import { toUsdtUnitsExact } from "./ledger-safety.js";
import { safeDiagnosticCode } from "./diagnostic-safety.js";

// PostgreSQL NUMERIC may return up to 18 fractional places, including zero padding.
 // Remove only insignificant trailing zeros. Reject nonrepresentable balances rather
 // than rounding them into a false reconciliation success.
function exactBalanceUnits(value) {
  if (typeof value !== "string" || !/^-?\d+(?:\.\d+)?$/.test(value)) {
    throw new Error("Invalid test wallet balance");
  }
  const decimal = value.includes(".") ? value.replace(/0+$/, "").replace(/\.$/, "") : value;
  const units = toUsdtUnitsExact(decimal);
  if (units < 0n) throw new Error("Negative test wallet balance");
  return units;
}

function reconciliationSnapshot(balance) {
  return {
    available: exactBalanceUnits(balance.AVAILABLE),
    hold: exactBalanceUnits(Object.hasOwn(balance, "WITHDRAWAL_HOLD") ? balance.WITHDRAWAL_HOLD : "0")
  };
}

export function registerOwnerRehearsal(bot, {
  productionPool, ownerId, getLanguage, env = process.env,
  createPool = config => new pg.Pool(config),
  reserve = reserveWithdrawal, cancel = cancelWithdrawal, balances = getWalletBalances
}) {
  let running = false;
  bot.command("admintest", async ctx => {
    if (ctx.from?.id !== ownerId || ctx.chat?.type !== "private" || ctx.chat.id !== ownerId) return;
    const language = await getLanguage(ctx);
    const say = (en, fa) => ctx.reply(language === "fa" ? fa : en);
    if (!env.PROFINO_TEST_DATABASE_URL || !env.PROFINO_TEST_DATABASE_NAME) {
      return say("Admin test database is not configured.", "دیتابیس آزمون مدیر هنوز تنظیم نشده است.");
    }
    if (running) return say("An admin test is already running.", "آزمون مدیر در حال اجراست.");
    running = true;
    let sandbox;
    try {
      const { rows: [production] } = await productionPool.query("SELECT current_database() AS name");
      if (!production?.name) throw new Error("Production database identity unavailable");
      sandbox = createPool({
        connectionString: env.PROFINO_TEST_DATABASE_URL, max: 1,
        connectionTimeoutMillis: 10000, query_timeout: 15000
      });
      const { rows: [test] } = await sandbox.query(
        "SELECT current_database() AS name, current_setting('profino.environment', true) AS marker"
      );
      if (!test?.name || test.name === production?.name ||
          test.name !== env.PROFINO_TEST_DATABASE_NAME || test.marker !== "isolated-staging") {
        throw new Error("Test database isolation check failed");
      }
      const { rows: [user] } = await sandbox.query(
        "SELECT id FROM users WHERE telegram_id = $1 AND status = 'active'", [ownerId]
      );
      if (!user) throw new Error("Active test owner is missing");
      const before = reconciliationSnapshot(await balances(sandbox, user.id));
      const request = await reserve(sandbox, user.id, "owner-rehearsal:" + ctx.message.message_id, "1");
      await cancel(sandbox, user.id, request.id);
      const after = reconciliationSnapshot(await balances(sandbox, user.id));
      // The sandbox owner must be dedicated to this rehearsal while it runs.
      if (before.available !== after.available || before.hold !== after.hold) {
        throw new Error("Test wallet reconciliation failed");
      }
      await say("Admin test passed. Reserved and released 1 test USDT. Balances reconciled.",
        "آزمون مدیر موفق بود. ۱ تتر آزمایشی رزرو و آزاد شد و موجودی تطبیق داده شد.");
    } catch (error) {
      console.error("[admin-test] rehearsal failed:", safeDiagnosticCode(error));
      await say("Admin test could not be completed. Review the test database and its logs.",
        "آزمون مدیر کامل نشد. دیتابیس آزمایشی و گزارش آن را بررسی کنید.");
    } finally {
      try { await sandbox?.end(); }
      finally { running = false; }
    }
  });
}
