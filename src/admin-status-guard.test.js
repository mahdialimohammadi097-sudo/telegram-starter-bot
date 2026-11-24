import test from "node:test";
import assert from "node:assert/strict";
import { isConfirmationCurrent } from "./admin-status-guard.js";

test("accepts a confirmation when the user's status is unchanged", () => {
  assert.equal(isConfirmationCurrent("active", "active", "blocked"), true);
});

test("rejects a confirmation after the user's status changed", () => {
  assert.equal(isConfirmationCurrent("blocked", "active", "blocked"), false);
});

test("rejects a confirmation that requests the current status", () => {
  assert.equal(isConfirmationCurrent("active", "active", "active"), false);
});

test("rejects unknown statuses", () => {
  assert.equal(isConfirmationCurrent("deleted", "deleted", "active"), false);
});

test("accepts pending accounts for an admin activation confirmation", () => {
  assert.equal(isConfirmationCurrent("pending", "pending", "active"), true);
});

test("all supported status transitions require a real change", () => {
  for (const current of ["active", "blocked", "pending"]) {
    for (const next of ["active", "blocked", "pending"]) {
      assert.equal(isConfirmationCurrent(current, current, next), current !== next);
    }
  }
});
test("all stale status confirmations fail closed", () => {
  for (const current of ["active", "blocked", "pending"]) {
    for (const previous of ["active", "blocked", "pending"]) {
      if (current === previous) continue;
      assert.equal(isConfirmationCurrent(current, previous, "active"), false);
    }
  }
});
test("invalid status in any position cannot authorize a transition", () => {
  for (const value of ["", "owner", "deleted", "ACTIVE", null, undefined]) {
    assert.equal(isConfirmationCurrent(value, "active", "blocked"), false);
    assert.equal(isConfirmationCurrent("active", value, "blocked"), false);
    assert.equal(isConfirmationCurrent("active", "active", value), false);
  }
});

test("admin status transaction rolls back if audit insertion fails", async () => {
  process.env.DATABASE_URL ??= "postgresql://localhost/profino_test";
  const { commitUserStatus } = await import("./admin-ops.js");
  const queries = [];
  let released = false;
  const client = {
    async query(sql) {
      queries.push(sql);
      if (sql === "BEGIN" || sql === "ROLLBACK") return {command:sql};
      if (sql.includes("xmin::text")) return { rowCount: 1, rows: [{ id: 9, status: "active", version: "12" }] };
      if (sql.includes("FROM admin_users")) return { rowCount: 1, rows: [{ user_id: 1 }] };
      if (sql.startsWith("UPDATE users")) return { rowCount: 1, rows: [{ id: 9, telegram_id: 123, status: "blocked" }] };
      if (sql.includes("INSERT INTO admin_audit_logs")) throw new Error("simulated audit failure");
      throw new Error("Unexpected SQL");
    },
    release() { released = true; }
  };
  await assert.rejects(
    commitUserStatus("123", "blocked", "active", "12", { connect: async () => client }),
    /simulated audit failure/
  );
  assert.equal(queries.includes("ROLLBACK"), true);
  assert.equal(queries.includes("COMMIT"), false);
  assert.equal(released, true);
});

test("admin status transaction destroys a connection when rollback itself fails", async () => {
  process.env.DATABASE_URL ??= "postgresql://localhost/profino_test";
  const { commitUserStatus } = await import("./admin-ops.js");
  const rollbackFailure = new Error("rollback unavailable");
  let releaseArgument;
  let commits = 0;
  const client = {
    async query(sql) {
      if (sql === "BEGIN") return {command:sql};
      if (sql === "ROLLBACK") throw rollbackFailure;
      if (sql === "COMMIT") { commits++; return {}; }
      if (sql.includes("xmin::text")) return { rowCount: 1, rows: [{ id: 9, status: "active", version: "12" }] };
      if (sql.includes("FROM admin_users")) return { rowCount: 1, rows: [{ user_id: 1 }] };
      if (sql.startsWith("UPDATE users")) return { rowCount: 1, rows: [{ id: 9, telegram_id: 123, status: "blocked" }] };
      if (sql.includes("INSERT INTO admin_audit_logs")) throw new Error("audit unavailable");
      throw new Error("Unexpected SQL");
    },
    release(error) { releaseArgument = error; }
  };
  await assert.rejects(
    commitUserStatus("123", "blocked", "active", "12", { connect: async () => client }),
    error => error.message === "audit unavailable" && error.rollbackError === rollbackFailure
  );
  assert.equal(commits, 0);
  assert.equal(releaseArgument, rollbackFailure);
});
