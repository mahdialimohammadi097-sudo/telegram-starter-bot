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
