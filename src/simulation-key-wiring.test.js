import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

test("Telegram investment and withdrawal handlers use user-scoped idempotency keys", () => {
  const source = readFileSync(new URL("./commands.js", import.meta.url), "utf8");
  assert.match(source, /openTestInvestment\(user\.id, key, name \+ " " \+ amount\)/);
  assert.match(source, /const key = simulationRequestKey\("investment", user\.id, ctx\.callbackQuery\.message\.message_id\)/);
  assert.match(source, /reserveTestWithdrawal\(user\.id, simulationRequestKey\("withdrawal", user\.id, messageId\), amount\)/);
  assert.doesNotMatch(source, /"telegram-withdraw:" \+ messageId/);
  assert.doesNotMatch(source, /"telegram-preview:" \+ ctx\.callbackQuery\.message\.message_id/);
});
