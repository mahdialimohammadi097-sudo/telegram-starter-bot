// Explicit database TLS policy. No implicit certificate-verification bypass.
export function resolveDatabaseTls(env = process.env) {
  const mode = env.PROFINO_DB_TLS_MODE ?? "disable";
  if (mode === "disable") return false;
  if (mode !== "verify-full") {
    throw new Error("Invalid PROFINO_DB_TLS_MODE: expected disable or verify-full");
  }
  const ca = env.PROFINO_DB_TLS_CA_PEM;
  if (ca !== undefined && (!ca.trim() || !ca.includes("BEGIN CERTIFICATE"))) {
    throw new Error("Invalid PROFINO_DB_TLS_CA_PEM certificate configuration");
  }
  return ca ? { rejectUnauthorized: true, ca } : { rejectUnauthorized: true };
}
