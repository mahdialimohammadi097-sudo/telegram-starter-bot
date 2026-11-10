import test from "node:test";
import assert from "node:assert/strict";
import { createRateLimiter } from "./rate-limit.js";

test("allows requests up to the user limit and blocks the next request", () => {
  const limiter = createRateLimiter({ windowMs: 10_000, userLimit: 3, adminLimit: 5 });
  for (let i = 0; i < 3; i += 1) assert.equal(limiter.consume({ userId: 10, now: 1_000 }).allowed, true);
  const blocked = limiter.consume({ userId: 10, now: 1_000 });
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.retryAfterSeconds, 10);
  assert.equal(blocked.shouldNotify, true);
});

test("resets the window and keeps users isolated", () => {
  const limiter = createRateLimiter({ windowMs: 1_000, userLimit: 1, adminLimit: 2 });
  assert.equal(limiter.consume({ userId: 1, now: 100 }).allowed, true);
  assert.equal(limiter.consume({ userId: 2, now: 100 }).allowed, true);
  assert.equal(limiter.consume({ userId: 1, now: 100 }).allowed, false);
  assert.equal(limiter.consume({ userId: 1, now: 1_100 }).allowed, true);
});

test("uses a separate, more generous administrator limit", () => {
  const limiter = createRateLimiter({ windowMs: 5_000, userLimit: 1, adminLimit: 2 });
  assert.equal(limiter.consume({ userId: 99, isAdmin: true, now: 0 }).allowed, true);
  assert.equal(limiter.consume({ userId: 99, isAdmin: true, now: 0 }).allowed, true);
  assert.equal(limiter.consume({ userId: 99, isAdmin: true, now: 0 }).allowed, false);
});

test("suppresses repeated warning notifications within the same window", () => {
  const limiter = createRateLimiter({ windowMs: 2_000, userLimit: 1, adminLimit: 2 });
  limiter.consume({ userId: 7, now: 0 });
  assert.equal(limiter.consume({ userId: 7, now: 0 }).shouldNotify, true);
  assert.equal(limiter.consume({ userId: 7, now: 500 }).shouldNotify, false);
  assert.equal(limiter.consume({ userId: 7, now: 2_000 }).allowed, true);
});

test("bounds memory used for per-user buckets", () => {
  const limiter = createRateLimiter({ maxEntries: 2 });
  limiter.consume({ userId: 1, now: 0 });
  limiter.consume({ userId: 2, now: 0 });
  limiter.consume({ userId: 3, now: 0 });
  assert.equal(limiter.size, 2);
});
