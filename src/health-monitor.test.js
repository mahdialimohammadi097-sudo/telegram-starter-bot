import test from "node:test";
import assert from "node:assert/strict";
import {
  getHealthChanges,
  formatHealthAlert
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
  assert.doesNotMatch(alert, /wallet|balance|transaction data/i);
});
