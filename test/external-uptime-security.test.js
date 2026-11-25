import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

const workflow = readFileSync(new URL("../.github/workflows/external-uptime.yml", import.meta.url), "utf8");
function stepScript(name) {
  const section = workflow.split("      - name: " + name + "\n")[1]?.split("\n      - name: ")[0];
  assert.ok(section);
  const script = section.split("        run: |\n")[1];
  assert.ok(script);
  return script.split("\n").map(line => line.replace(/^ {10}/, "")).join("\n");
}
function sandbox(fn) {
  const cwd = mkdtempSync(join(tmpdir(), "profino-monitor-"));
  try {
    mkdirSync(join(cwd, ".profinostate"));
    const output = join(cwd, "output");
    const run = (script, env = {}) => {
      writeFileSync(output, "");
      execFileSync("bash", ["-e", "-c", script], {
        cwd, env: { PATH: process.env.PATH, GITHUB_OUTPUT: output, ...env }, stdio: "pipe"
      });
      return readFileSync(output, "utf8");
    };
    fn(cwd, run);
  } finally { rmSync(cwd, { recursive: true, force: true }); }
}
test("uptime monitor accepts only known previous cache states", () => sandbox((cwd,run) => {
  for (const [input, expected] of [["up","up"],["down","down"],["unknown","unknown"],["up\ninjected=value","unknown"]]) {
    writeFileSync(join(cwd,".profinostate/status"),input);
    assert.equal(run(stepScript("Read previous monitor state")), "status=" + expected + "\n");
  }
}));
test("uptime check requires both endpoints, using only fake curl responses", () => sandbox((_cwd,run) => {
  const stub = 'sleep() { :; }\ncurl() { case "${*: -1}" in */healthz) printf 200;; *) printf "%s" "$FAKE_ROOT";; esac; }\n';
  const script = stub + stepScript("Check public application endpoints");
  assert.match(run(script,{FAKE_ROOT:"200"}),/^status=up\n/m);
  assert.match(run(script,{FAKE_ROOT:"503"}),/^status=down\n/m);
}));
test("monitor rejects invalid state before saving", () => sandbox((cwd,run) => {
  const script = stepScript("Prepare monitor state");
  run(script,{CURRENT_STATUS:"down"});
  const path = join(cwd,".profinostate/status");
  assert.equal(readFileSync(path,"utf8"),"down");
  assert.throws(()=>run(script,{CURRENT_STATUS:"unexpected"}));
  assert.equal(readFileSync(path,"utf8"),"down");
}));
