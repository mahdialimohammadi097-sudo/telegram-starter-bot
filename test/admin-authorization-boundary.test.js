import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

for (const [file, registration, expected] of [
  ["post-management.js", "registerPostManagement", 8],
  ["post-history.js", "registerPostHistory", 8],
  ["admin-ops.js", "registerAdminOps", 24]
]) {
  test(file + " rejects unauthorized commands and callbacks before database access", async () => {
    const source = readFileSync(new URL("../src/" + file, import.meta.url), "utf8")
      .replace(/^import .*;$/gm, "")
      .replace(/const (ADMIN_ID|SUPER_ADMIN_ID) = \d+;/g, "const $1 = 123;")
      .replace(/export (async function|function)/g, "$1");
    const handlers = [];
    let queries = 0;
    const rejectQuery = async () => { queries++; throw new Error("unexpected database access"); };
    const register = vm.runInNewContext(source + "\n" + registration, {
      pool: { query: rejectQuery, connect: rejectQuery }, getAdminLanguage: rejectQuery
    });
    register({
      callbackQuery: (_pattern, fn) => handlers.push(fn),
      command: (_pattern, fn) => handlers.push(fn),
      on() {}
    }, { inspectTestQueue: rejectQuery, testWithdrawalReview: { list: rejectQuery, inspect: rejectQuery, release: rejectQuery } });
    assert.equal(handlers.length, expected);
    for (const handler of handlers) {
      for (const [actor, chat] of [
        [456, { id: 456, type: "private" }],
        [123, { id: 456, type: "private" }],
        [123, { id: 123, type: "group" }],
        [undefined, { id: 123, type: "private" }],
        [123, undefined]
      ]) {
        const responses = [];
        await handler({
          from: { id: actor }, chat, match: "",
          callbackQuery: { data: "fixture:1", message: { chat } },
          answerCallbackQuery: async value => responses.push(value.text),
          reply: async value => responses.push(value)
        });
        assert.equal(responses.length, 1);
        assert.match(responses[0], /Unauthorized|Access denied/);
      }
    }
    assert.equal(queries, 0);
  });
}

test("post management rejects contradictory callback chat before lookup or session edits", async () => {
  const source=readFileSync(new URL("../src/post-management.js",import.meta.url),"utf8")
    .replace(/^import .*;$/gm,"").replace(/const ADMIN_ID = \d+;/,"const ADMIN_ID = 123;")
    .replace(/export (async function|function)/g,"$1");
  const deny=()=>assert.fail("unauthorized callback reached database or language lookup");
  const register=vm.runInNewContext(source+"\nregisterPostManagement",{pool:{query:deny,connect:deny},getAdminLanguage:deny});
  const handlers=[];
  register({callbackQuery:(_pattern,fn)=>handlers.push(fn),on(){}});
  assert.ok(handlers.length>0);
  for(const fn of handlers){
    const own={id:123,type:"private"},other={id:456,type:"private"};
    for(const [chat,message] of [[other,{chat:own}],[own,{chat:other}],[own,undefined],[{id:123,type:"group"},{chat:own}]]){
      const replies=[];
      await fn({from:{id:123},chat,callbackQuery:{data:"post_edit_back:1",message},answerCallbackQuery:async x=>replies.push(x.text)});
      assert.deepEqual(replies,["Unauthorized."]);
    }
  }
});
test("scheduler uses the same fail-closed callback identity in recovery and normal processing",()=>{
  const source=readFileSync(new URL("../src/scheduler.js",import.meta.url),"utf8");
  const fn=source.match(/function isAdminSchedulerCallback\(ctx\) \{[\s\S]*?\n\}/)?.[0];
  assert.ok(fn);
  const guard=vm.runInNewContext("const ADMIN_ID=123;\n"+fn+"\nisAdminSchedulerCallback");
  const own={id:123,type:"private"},other={id:456,type:"private"};
  for(const [from,chat,message] of [[{id:123},other,{chat:own}],[{id:123},own,{chat:other}],[{id:123},own,undefined],[undefined,own,{chat:own}],[{id:456},own,{chat:own}]]){
    assert.equal(guard({from,chat,callbackQuery:{message}}),false);
  }
  assert.equal(guard({from:{id:123},chat:own,callbackQuery:{message:{chat:own}}}),true);
  assert.match(source,/if \(!isAdminSchedulerCallback\(ctx\)\)/);
  assert.match(source,/const authorized = isAdminSchedulerCallback\(ctx\)/);
});
