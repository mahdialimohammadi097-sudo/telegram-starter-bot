import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { detectSecretKinds } from "./check-secret-patterns.js";

// Exact reviewed blobs of synthetic diagnostics and disposable CI fixtures.
// Only its database-url classification is excluded; no file or path is globally exempt.
const reviewedFixtures = new Set(["c8a61100ee20e7f89e1b6c4d017f1c19aba4118f","601880bad18f3787b771778846a67be7b240cdfb","19385375fcfd398a49af2e17054ec0a63b9c5e67","832a6cc04728d65f11417716887ebd8439adb67d","3162bc0ee3c1653a22207d09847002c1eee4c6db"]);
const maxBuffer = 32 * 1024 * 1024;

export function scanHistory(cwd = process.cwd()) {
  const git = (args, extra = {}) => execFileSync("git", args, {
    cwd, maxBuffer, stdio: ["pipe", "pipe", "pipe"], ...extra
  });
  if (git(["rev-parse", "--is-shallow-repository"], { encoding: "utf8" }).trim() !== "false") {
    throw new Error("Full history required");
  }
  const objects = git(["rev-list", "--objects", "--no-object-names", "HEAD"], { encoding: "utf8" });
  const metadata = git(["cat-file", "--batch-check=%(objectname) %(objecttype) %(objectsize)"], {
    input: objects, encoding: "utf8"
  }).trim().split("\n").filter(Boolean);
  const findings = new Map();
  let scanned = 0, binary = 0, reviewed = 0;
  for (const line of metadata) {
    const match = /^([a-f0-9]{40,64}) (blob|commit|tree|tag) (\d+)$/.exec(line);
    if (!match) throw new Error("Unexpected Git metadata");
    const [, oid, type] = match;
    if (type !== "blob") continue;
    const bytes = git(["cat-file", "blob", oid]);
    if (bytes.includes(0)) { binary++; continue; }
    scanned++;
    for (const kind of detectSecretKinds(bytes.toString("utf8"))) {
      if (reviewedFixtures.has(oid) && kind === "database-url") { reviewed++; continue; }
      findings.set(kind, (findings.get(kind) ?? 0) + 1);
    }
  }
  return { scanned, binary, reviewed, findings };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const result = scanHistory();
    console.log("Historical text blobs scanned: " + result.scanned + "; binary excluded: " + result.binary + "; reviewed fixture matches: " + result.reviewed);
    for (const [kind, count] of result.findings) console.error("History secret policy: " + kind + " in " + count + " unique blob(s).");
    if (result.findings.size) process.exitCode = 1;
  } catch {
    console.error("History secret scan could not complete.");
    process.exitCode = 1;
  }
}
