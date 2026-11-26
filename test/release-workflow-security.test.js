import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
const read=name=>readFileSync(new URL("../.github/workflows/"+name,import.meta.url),"utf8");

test("manual dependency verification has no repository-writing capability",()=>{
 const workflow=read("main.yml");
 assert.match(workflow,/permissions:\s*\n\s+contents: read\b/);
 assert.match(workflow,/persist-credentials: false\b/);
 assert.match(workflow,/npm ci --ignore-scripts\b/);
 assert.match(workflow,/git diff --exit-code -- package\.json package-lock\.json/);
 assert.doesNotMatch(workflow,/contents:\s*write\b|git\s+(?:push|commit)\b|npm\s+install\b/);
});
test("testnet receipt inspection does not retain checkout credentials",()=>{
 assert.match(read("testnet-receipt.yml"),/persist-credentials: false\b/);
});

test("rollback rehearsal covers all pull requests and retains the pinned lock and isolated execution",()=>{
 const workflow=read("postgres-restore.yml");
 assert.match(workflow,/^  pull_request:\s*\n  workflow_dispatch:/m);
 assert.doesNotMatch(workflow,/^\s+paths(?:-ignore)?:/m);
 assert.match(workflow,/ref: e0d7509b43605493beb6a20485d5d17ce0ef8e16\b/);
 assert.match(workflow,/cmp package-lock\.json rollback-reference\/package-lock\.json/);
 assert.match(workflow,/permissions:\s*\n\s+contents: read\b/);
 assert.equal((workflow.match(/persist-credentials: false/g)||[]).length,2);
 assert.match(workflow,/docker run --rm --network none --user postgres/);
 assert.match(workflow,/\$GITHUB_WORKSPACE:\/work:ro/);
 assert.doesNotMatch(workflow,/pull_request_target:|contents:\s*write\b|continue-on-error:/);
});

test("all four supplemental release checks report on every pull request",()=>{
 for(const [file,job] of [
  ["catalog-owner-tests.yml","ownership"],
  ["catalog-owner-postgres.yml","concurrency"],
  ["fadehost-schema-audit-tests.yml","safe-audit"],
  ["postgres-restore.yml","restore"]
 ]){
  const workflow=read(file);
  assert.match(workflow,/^  pull_request:\s*\n/m,file);
  assert.doesNotMatch(workflow,/^\s+paths(?:-ignore)?:/m,file);
  assert.match(workflow,new RegExp("^  "+job+":\\s*$","m"),file);
  assert.match(workflow,/permissions:\s*\n\s+contents: read\b/,file);
  assert.doesNotMatch(workflow,/pull_request_target:|contents:\s*write\b|continue-on-error:/,file);
 }
});

test("manual ledger catalog export uses a bounded catalog-first read-only snapshot",()=>{
 const sql=readFileSync(new URL("../scripts/ledger-catalog.sql",import.meta.url),"utf8");
 assert.match(sql,/BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;/);
 assert.match(sql,/SET LOCAL statement_timeout = '10s';/);
 assert.match(sql,/SET LOCAL lock_timeout = '3s';/);
 assert.match(sql,/SET LOCAL search_path = pg_catalog, pg_temp;/);
 assert.doesNotMatch(sql,/SET LOCAL search_path[^;]*public/);
 assert.match(read("validate.yml"),/cmp "\$RUNNER_TEMP\/wallet_schema_reference\.catalog" "\$RUNNER_TEMP\/shadow\.catalog"/);
});

test("legacy integration workflows enforce complete financial evidence and reset both disposable databases",()=>{
 for(const [file,fullTap] of [["integration-validator.yml","profino-tests"],["integration-postgres-matrix.yml","profino-matrix"]]){
  const workflow=read(file);
  assert.ok(workflow.includes('node scripts/verify-financial-test-evidence.js "$RUNNER_TEMP/'+fullTap+'.tap" --full'),file);
  assert.ok(workflow.includes('node scripts/verify-financial-test-evidence.js "$RUNNER_TEMP/profino-focused.tap"'),file);
  assert.match(workflow,/for db in profino_test catalog_rehearsal; do/,file);
  assert.match(workflow,/psql -h localhost -U postgres -d postgres -v ON_ERROR_STOP=1/,file);
  assert.match(workflow,/npm run pretest:postgres/,file);
  assert.match(workflow,/node --test --test-reporter=tap src\/\*\.postgres\.test\.js/,file);
  assert.match(workflow,/set -euo pipefail/,file);
  assert.doesNotMatch(workflow,/continue-on-error:|pull_request_target:|contents:\s*write\b/,file);
 }
});
