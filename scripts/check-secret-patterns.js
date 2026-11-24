import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

// Deliberately narrow, high-confidence patterns. No matched value is returned.
const rules = [
  ["private-key", /-----BEGIN (?:RSA |EC |DSA |OPENSSH |ENCRYPTED )?PRIVATE KEY-----/],
  ["github-token", /\b(?:gh[pousr]_[A-Za-z0-9]{36,255}|github_pat_[A-Za-z0-9_]{50,255})\b/],
  ["telegram-token", /\b[1-9]\d{7,11}:[A-Za-z0-9_-]{35}\b/],
  ["database-url", /\bpostgres(?:ql)?:\/\/[^\s:/@]+:[^\s/@]+@[^\s/"'`]+/gi]
];

function placeholderDatabaseUrl(value) {
  const password = value.slice(value.indexOf("://") + 3).split("@")[0].split(":").slice(1).join(":");
  // Only conventional documentation markers; never allow an arbitrary hostname.
  return /^(?:password|pass|example|placeholder|changeme|<password>|\$\{[A-Z_]+\}|\*{3,})$/i.test(password);
}

export function detectSecretKinds(source) {
  const findings = [];
  for (const [kind, pattern] of rules) {
    if (kind === "database-url") {
      if ([...source.matchAll(pattern)].some(match => !placeholderDatabaseUrl(match[0]))) findings.push(kind);
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
    for (const kind of detectSecretKinds(bytes.toString("utf8"))) {
      counts.set(kind, (counts.get(kind) ?? 0) + 1);
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
