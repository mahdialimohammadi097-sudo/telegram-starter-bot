// Test-only defense in depth. This does not prove that a localhost database is
// disposable: the operator must provision an isolated service, never a tunnel
// to production, and explicitly opt in.
export function isDisposablePostgresTarget(url, database, env = process.env) {
  if (env.PROFINO_DISPOSABLE_POSTGRES !== "yes" ||
      typeof url !== "string" ||
      !["profino_test", "catalog_rehearsal"].includes(database) ||
      /[?#\s]/.test(url)) return false;
  // Accept literal loopback authorities and database names only. URL parsers
  // can normalize dot segments or escaped host names differently.
  const literal = /^postgres(?:ql)?:\/\/(?:[^/@?#\\\s]+@)?(?:localhost|127\.0\.0\.1)(?::[0-9]+)?\/(profino_test|catalog_rehearsal)$/;
  if (literal.exec(url)?.[1] !== database) return false;
  try {
    const target = new URL(url);
    return ["postgres:", "postgresql:"].includes(target.protocol) &&
      ["localhost", "127.0.0.1"].includes(target.hostname) &&
      target.pathname === "/" + database &&
      !target.search && !target.hash;
  } catch {
    return false;
  }
}
