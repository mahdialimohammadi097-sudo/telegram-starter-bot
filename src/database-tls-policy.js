// Explicit database TLS policy. No implicit certificate-verification bypass.
export function resolveDatabaseTls(env = process.env) {
  const legacy = env.PROFINO_DATABASE_TLS || undefined;
  if (legacy && !["disabled", "verify"].includes(legacy)) {
    throw new Error("PROFINO_DATABASE_TLS must be disabled or verify");
  }
  const legacyMode = legacy === "verify" ? "verify-full" : "disable";
  if (legacy && env.PROFINO_DB_TLS_MODE !== undefined && env.PROFINO_DB_TLS_MODE !== legacyMode) {
    throw new Error("Conflicting database TLS configuration");
  }
  const mode = env.PROFINO_DB_TLS_MODE ?? (legacy ? legacyMode : "disable");
  if (!["disable", "verify-full"].includes(mode)) {
    throw new Error("Invalid PROFINO_DB_TLS_MODE: expected disable or verify-full");
  }
  // node-postgres may replace the explicit ssl object when URL TLS parameters exist.
  // Reject such ambiguity instead of silently losing certificate verification.
  let url;
  try {
    url = new URL(env.DATABASE_URL ?? "postgresql://localhost");
  } catch {
    // URL parsing errors can contain the original connection string.
    throw new Error("Invalid DATABASE_URL configuration");
  }
  if (!["postgres:", "postgresql:"].includes(url.protocol)) {
    throw new Error("Invalid DATABASE_URL protocol");
  }
  for (const key of url.searchParams.keys()) {
    if (key.toLowerCase().startsWith("ssl") || key.toLowerCase() === "uselibpqcompat") {
      throw new Error("DATABASE_URL TLS parameters conflict with explicit TLS policy");
    }
  }
  if (mode === "disable") return false;
  const ca = env.PROFINO_DB_TLS_CA_PEM;
  if (ca !== undefined && (!ca.trim() || !ca.includes("BEGIN CERTIFICATE"))) {
    throw new Error("Invalid PROFINO_DB_TLS_CA_PEM certificate configuration");
  }
  return ca ? { rejectUnauthorized: true, ca } : { rejectUnauthorized: true };
}
