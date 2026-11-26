import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

export function isSensitivePath(path) {
  const basename = path.split("/").at(-1).toLowerCase();
  if (basename === ".env.example" || basename === ".env.sample") return false;
  return /^\.env(?:\.|$)/.test(basename) ||
    /^(?:\.pgpass|\.?pg_service\.conf|\.npmrc\.local)$/.test(basename) ||
    /\.(?:pem|key|p12|pfx|pgpass)$/.test(basename) ||
    /\.(?:dump|backup|pgdump|sql\.(?:gz|bz2|xz|zst|zip))(?:\.(?:gz|bz2|xz|zst|zip|age|gpg|enc|aes))*$/.test(basename) ||
    /\.sql\.(?:age|gpg|enc|aes)$/.test(basename) ||
    /^(?:id_rsa|id_ed25519|id_ecdsa|id_dsa)$/.test(basename);
}

export function countSensitivePaths(paths) {
  return paths.filter(isSensitivePath).length;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const files = execFileSync("git", ["ls-files", "-z"], { encoding: "utf8" }).split("\0").filter(Boolean);
  const count = countSensitivePaths(files);
  if (count) {
    // Never print filenames or file contents: names may themselves contain secrets.
    console.error("Credential/backup file policy failed: " + count + " prohibited tracked file(s).");
    process.exitCode = 1;
  } else {
    console.log("Credential/backup filename policy passed.");
  }
}
