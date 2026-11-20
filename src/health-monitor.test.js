import test from "node:test";
import assert from "node:assert/strict";
import {
  getHealthChanges,
  formatHealthAlert,
  startHealthMonitor
} from "./health-monitor.js";

test("reports only service state transitions", () => {
  assert.deepEqual(
    getHealthChanges(
      { telegram: true, database: true },
      { telegram: true, database: false }
    ),
    [{ service: "database", status: "UNAVAILABLE" }]
  );
});

test("reports recovery transitions", () => {
  assert.deepEqual(
    getHealthChanges(
      { telegram: false, database: false },
      { telegram: true, database: true }
    ),
    [
      { service: "telegram", status: "RECOVERED" },
      { service: "database", status: "RECOVERED" }
    ]
  );
});

test("does not report unchanged healthy services", () => {
  assert.deepEqual(
    getHealthChanges(
      { telegram: true, database: true },
      { telegram: true, database: true }
    ),
    []
  );
});

test("alert contains status only and a timestamp", () => {
  const alert = formatHealthAlert(
    [{ service: "telegram", status: "UNAVAILABLE" }],
    new Date("2026-11-10T10:00:00.000Z")
  );
  assert.match(alert, /2026-11-10T10:00:00.000Z/);
  assert.match(alert, /TELEGRAM: UNAVAILABLE/);
  assert.doesNotMatch(alert, /user_id|wallet_address|balance_amount|transaction_id/i);
});

test("monitor reports webhook receiver health through the status callback", async () => {
  let observed = null;
  const monitor = startHealthMonitor({
    bot: { api: { getMe: async () => ({ id: 1 }), sendMessage: async () => {} } },
    pool: { query: async () => ({ rows: [{ health_check: 1 }] }) },
    telegramCheck: async () => false,
    onStatus: (status) => { observed = status; },
    logger: { warn() {}, error() {} },
    intervalMs: 60_000
  });
  await monitor.ready;
  monitor.stop();
  assert.deepEqual(observed, { telegram: false, database: true });
});

test("an undelivered outage retries, deduplicates and reports recovery", async t => {
  const attempts = [];
  const diagnostics = [];
  let databaseReady = false;
  const monitor = startHealthMonitor({
    telegramCheck: async () => true,
    pool: { query: async () => { if (!databaseReady) throw new Error("fixture outage"); } },
    bot: { api: { sendMessage: async (_recipient, text) => {
      attempts.push(text);
      if (attempts.length === 1) throw Object.assign(new Error("fixture detail"), { error_code: "private fixture value" });
    } } },
    logger: { warn() {}, error(...args) { diagnostics.push(args); } },
    intervalMs: 60000
  });
  t.after(() => monitor.stop());
  await monitor.ready;
  await monitor.check();
  await monitor.check();
  databaseReady = true;
  await monitor.check();
  await monitor.check();
  assert.equal(attempts.length, 3);
  assert.match(attempts[0], /DATABASE: UNAVAILABLE/);
  assert.match(attempts[1], /DATABASE: UNAVAILABLE/);
  assert.match(attempts[2], /DATABASE: RECOVERED/);
  assert.deepEqual(diagnostics, [["[health] alert delivery failed:", "telegram_send_failed"]]);
});

test("stopping during a health probe suppresses stale status and alerts", async () => {
  let failProbe;
  let checks = 0;
  const events = [];
  const monitor = startHealthMonitor({
    telegramCheck: async () => true,
    pool: { query() {
      checks++;
      return new Promise((_resolve, reject) => { failProbe = reject; });
    } },
    bot: { api: { sendMessage: async () => { events.push("alert"); } } },
    onStatus: () => { events.push("status"); },
    logger: { warn() {}, error() {} }
  });
  monitor.stop();
  failProbe(new Error("offline"));
  await monitor.ready;
  assert.deepEqual(events, []);
  await monitor.check();
  assert.equal(checks, 1);
});
