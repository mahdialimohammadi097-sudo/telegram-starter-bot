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
 assert.match(workflow,/ref: aeefcc9f2b94e54f164b9e3af89ff7e10a10b89f\b/);
 assert.match(workflow,/cmp package-lock\.json rollback-reference\/package-lock\.json/);
 assert.match(workflow,/permissions:\s*\n\s+contents: read\b/);
 assert.equal((workflow.match(/persist-credentials: false/g)||[]).length,2);
 assert.match(workflow,/docker run --rm --network none --user postgres/);
 assert.match(workflow,/\$GITHUB_WORKSPACE:\/work:ro/);
 assert.doesNotMatch(workflow,/pull_request_target:|contents:\s*write\b|continue-on-error:/);
});
