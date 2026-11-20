import test from "node:test";
import assert from "node:assert/strict";
import { previewSettlement } from "./plan-preview.js";

test("v1.0 preview matches all fifteen settlement amounts after fees", () => {
  const amounts = ["10", "25", "50", "75", "100"];
  for (const [plan, expected] of [
    ["STARTER", ["10.192", "25.48", "50.96", "76.44", "101.92"]],
    ["SMART", ["10.944", "27.36", "54.72", "82.08", "109.44"]],
    ["PRO", ["13.16", "32.9", "65.8", "98.7", "131.6"]]
  ]) {
    assert.deepEqual(amounts.map(amount => previewSettlement(plan + " " + amount).payout), expected);
  }
  assert.deepEqual(previewSettlement("  smart  25 "), {
    name: "SMART", days: 30, profitPercent: 14, feePercent: 4, amount: "25",
    profit: "3.5", gross: "28.5", fee: "1.14", payout: "27.36"
  });
});

test("unsupported plans and amounts cannot produce settlement previews", () => {
  for (const input of [null, "", "PRO", "PRO 0", "PRO 101", "PRO 12", "PRO 10.01", "PRO -10", "PRO 10 extra", "OTHER 25"]) {
    assert.equal(previewSettlement(input), null);
  }
});

test("private admin command uses the selected language and only reads preferences", async t => {
  const originalUrl = process.env.DATABASE_URL;
  process.env.DATABASE_URL ||= "postgres://localhost/unused_command_test";
  const { pool } = await import("./database.js");
  const { registerAdminOps } = await import("./admin-ops.js");
  if (originalUrl === undefined) delete process.env.DATABASE_URL;
  const commands = new Map();
  registerAdminOps({ command: (name, handler) => commands.set(name, handler), callbackQuery() {} });
  let language = "fa";
  const lookup = t.mock.method(pool, "query", async (sql, args) => {
    assert.match(sql.trim(), /^SELECT ap.language/);
    assert.deepEqual(args, [8810232463]);
    return { rows: [{ language }] };
  });
  const invoke = (id, type, match) => commands.get("planpreview")({
    from: { id }, chat: { type }, match, reply: message => message
  });
  assert.equal(await invoke(123, "private", "PRO 100"), "Access denied.");
  assert.equal(await invoke(8810232463, "group", "PRO 100"), "Access denied.");
  assert.equal(lookup.mock.callCount(), 0);
  assert.match(await invoke(8810232463, "private", "PRO 100"), /مبلغ خالص تسویه: 131\.6/);
  language = "en";
  assert.match(await invoke(8810232463, "private", "PRO 100"), /Net settlement: 131\.6/);
  assert.match(await invoke(8810232463, "private", "PRO 12"), /Example: \/planpreview SMART 25/);
  assert.equal(lookup.mock.callCount(), 3);
});
