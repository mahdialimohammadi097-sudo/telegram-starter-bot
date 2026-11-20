// Explicit database TLS policy. No implicit certificate-verification bypass.
export function resolveDatabaseTls(env = process.env) {
  const mode = env.PROFINO_DB_TLS_MODE ?? "disable";
  if (mode === "disable") return false;
  if (mode !== "verify-full") {
    throw new Error("Invalid PROFINO_DB_TLS_MODE: expected disable or verify-full");
  }
  // node-postgres may replace the explicit ssl object when URL TLS parameters exist.
  // Reject such ambiguity instead of silently losing certificate verification.
  const url = new URL(env.DATABASE_URL ?? "postgresql://localhost");
  for (const key of ["sslmode", "sslrootcert", "sslcert", "sslkey"]) {
    if (url.searchParams.has(key)) {
      throw new Error("Database URL TLS parameters conflict with verified TLS policy");
    }
  }
  const ca = env.PROFINO_DB_TLS_CA_PEM;
  if (ca !== undefined && (!ca.trim() || !ca.includes("BEGIN CERTIFICATE"))) {
    throw new Error("Invalid PROFINO_DB_TLS_CA_PEM certificate configuration");
  }
  return ca ? { rejectUnauthorized: true, ca } : { rejectUnauthorized: true };
}
