import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

// Deliberately narrow, high-confidence patterns. No matched value is returned.
const rules = [
  ["private-key", /-----BEGIN (?:RSA |EC |DSA |OPENSSH |ENCRYPTED )?PRIVATE KEY-----/],
  ["github-token", /\b(?:gh[pousr]_[A-Za-z0-9]{36,255}|github_pat_[A-Za-z0-9_]{50,255})\b/],
  ["telegram-token", /\b[1-9]\d{7,11}:[A-Za-z0-9_-]{35}(?![A-Za-z0-9_-])/],
  ["database-url", /\bpostgres(?:ql)?:\/\/[^\s:/@"'`]+:[^\s/@"'`]+@[^\s"'`]+/gi]
];

function placeholderDatabaseUrl(value) {
  const password = value.slice(value.indexOf("://") + 3).split("@")[0].split(":").slice(1).join(":");
  // Explicitly documented disposable CI databases; never exempt remote hosts.
  if (/^postgres(?:ql)?:\/\/postgres:postgres@(?:localhost|127\.0\.0\.1):5432\/(?:profino_test|catalog_rehearsal|wallet_drill_source|wallet_drill_restored)$/i.test(value)) return true;
  if (/^(?:<password>|\$\{[A-Z_]+\}|\*{3,})$/i.test(password)) return true;
  return /^(?:password|pass|example|placeholder|changeme)$/i.test(password) &&
    /^postgres(?:ql)?:\/\/[^@]+@(?:localhost|127\.0\.0\.1)(?::\d+)?(?:\/|$)/i.test(value);
}

// Exact values reviewed in these synthetic diagnostic tests and disposable CI only.
// Neither a whole file nor a remote host is exempt from credential scanning.
const reviewedFixtures = Object.freeze({
  "src/admin-diagnostic-backport.test.js": ["postgresql://" + "fixture:fixture@127.0.0.1:1/diagnostic_fixture"],
  ".github/workflows/catalog-owner-postgres.yml": ["postgresql://" + "postgres:rehearsal@localhost:5432/catalog_rehearsal"],
  "src/database-idle-error.test.js": ["postgres://" + "secret:password@private-host/db"],
  "src/diagnostic-safety.test.js": ["postgres://" + "admin:secret@db.internal/prod"],
  "src/health-report.test.js": ["postgres://" + "admin:super-secret@db.internal/prod"]
});

export function detectSecretKinds(source, path = "") {
  const findings = [];
  for (const [kind, pattern] of rules) {
    if (kind === "database-url") {
      if ([...source.matchAll(pattern)].some(match => !placeholderDatabaseUrl(match[0]) && !(reviewedFixtures[path] || []).includes(match[0]))) findings.push(kind);
    } else if (pattern.test(source)) findings.push(kind);
  }
  return findings;
}

function trackedScan() {
  const paths = execFileSync("git", ["ls-files", "-z"], { encoding: "utf8" }).split("\0").filter(Boolean);
  const counts = new Map();
  for (const path of paths) {
    const bytes = execFileSync("git", ["show", ":" + path], { maxBuffer: 32 * 1024 * 1024 });
    // Binary content is outside the scope of this text scanner.
    if (bytes.includes(0)) continue;
    for (const kind of detectSecretKinds(bytes.toString("utf8"), path)) {
      counts.set(kind, (counts.get(kind) ?? 0) + 1);
      // Identify the exact indexed blob for private review without printing the
      // matching value, filename, or potentially sensitive exception text.
      const oid = execFileSync("git", ["rev-parse", ":" + path], { encoding: "utf8" }).trim();
      if (!/^[a-f0-9]{40,64}$/.test(oid)) throw new Error("Unexpected Git object identifier");
      console.error("Tracked review object: " + kind + " " + oid);
    }
  }
  return counts;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const findings = trackedScan();
    if (findings.size) {
      for (const [kind, count] of findings) console.error("Secret policy: " + kind + " in " + count + " tracked file(s).");
      process.exitCode = 1;
    } else console.log("Tracked text secret pattern scan passed.");
  } catch {
    console.error("Tracked text secret scan could not complete.");
    process.exitCode = 1;
  }
}
