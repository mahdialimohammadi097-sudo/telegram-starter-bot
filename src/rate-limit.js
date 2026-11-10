// Per-process fixed-window limiter for incoming private-chat updates.
export function createRateLimiter({ windowMs = 10_000, userLimit = 20, adminLimit = 40, maxEntries = 5_000 } = {}) {
  if (!Number.isFinite(windowMs) || windowMs <= 0) throw new TypeError("windowMs must be positive");
  if (![userLimit, adminLimit, maxEntries].every(value => Number.isInteger(value) && value > 0)) {
    throw new TypeError("limits and maxEntries must be positive integers");
  }
  const buckets = new Map();
  let operations = 0;
  function prune(now) {
    for (const [key, bucket] of buckets) {
      if (now - bucket.lastSeenAt >= windowMs * 2) buckets.delete(key);
    }
  }
  function consume({ userId, isAdmin = false, now = Date.now() }) {
    if (userId === undefined || userId === null) throw new TypeError("userId is required");
    if (!Number.isFinite(now)) throw new TypeError("now must be a finite timestamp");
    operations += 1;
    if (operations % 128 === 0) prune(now);
    const key = String(userId);
    const limit = isAdmin ? adminLimit : userLimit;
    let bucket = buckets.get(key);
    if (!bucket || now - bucket.windowStartedAt >= windowMs || now < bucket.windowStartedAt) {
      bucket = { windowStartedAt: now, count: 0, lastSeenAt: now, lastNotifiedAt: null };
    }
    bucket.lastSeenAt = now;
    buckets.delete(key);
    buckets.set(key, bucket);
    if (bucket.count < limit) {
      bucket.count += 1;
      if (buckets.size > maxEntries) buckets.delete(buckets.keys().next().value);
      return { allowed: true, retryAfterSeconds: 0, shouldNotify: false };
    }
    const shouldNotify = bucket.lastNotifiedAt === null || now - bucket.lastNotifiedAt >= windowMs;
    if (shouldNotify) bucket.lastNotifiedAt = now;
    if (buckets.size > maxEntries) buckets.delete(buckets.keys().next().value);
    return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil((bucket.windowStartedAt + windowMs - now) / 1000)), shouldNotify };
  }
  return { consume, get size() { return buckets.size; } };
}
