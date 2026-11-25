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
