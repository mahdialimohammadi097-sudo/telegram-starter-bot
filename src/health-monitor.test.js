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

test("synchronous probe failure marks only the affected service unavailable", async (t) => {
  const statuses = [];
  const monitor = startHealthMonitor({
    bot: { api: { sendMessage: async () => {} } },
    pool: { query() { throw new Error("synthetic database failure"); } },
    telegramCheck: () => true,
    onStatus: status => statuses.push(status),
    logger: { warn() {}, error() {} }
  });
  t.after(() => monitor.stop());
  await monitor.ready;
  assert.deepEqual(statuses, [{ telegram: true, database: false }]);
});

test("stopping the monitor suppresses stale results and subsequent checks", async (t) => {
  const statuses = [];
  let checks = 0, alerts = 0, finish;
  const pending = new Promise(resolve => { finish = resolve; });
  const monitor = startHealthMonitor({
    bot: { api: { sendMessage: async () => { alerts++; } } },
    pool: { query: async () => { await pending; throw new Error("synthetic outage"); } },
    telegramCheck: async () => { checks++; return true; },
    onStatus: status => statuses.push(status),
    logger: { warn() {}, error() {} }
  });
  t.after(() => monitor.stop());
  await Promise.resolve();
  monitor.stop();
  finish();
  await monitor.ready;
  await monitor.check();
  assert.equal(checks, 1);
  assert.equal(alerts, 0);
  assert.deepEqual(statuses, []);
});
