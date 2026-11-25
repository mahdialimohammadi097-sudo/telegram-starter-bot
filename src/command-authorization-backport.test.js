import test from "node:test";
import assert from "node:assert/strict";
process.env.DATABASE_URL="postgresql://"+"fixture:fixture@127.0.0.1:1/command_fixture";
const {pool}=await import("./database.js");
const {registerCommands}=await import("./commands.js");
const {registerPostHistory}=await import("./post-history.js");
const ownerId=8810232463;


test("global command middleware rejects mismatched private sender before database or next",async t=>{
 const middleware=[];
 registerCommands({use:fn=>middleware.push(fn),command(){},callbackQuery(){},on(){},hears(){}});
 assert.ok(middleware.length>0);
 const query=t.mock.method(pool,"query",async()=>assert.fail("must not query"));
 for(const id of [ownerId,ownerId+1]){
  const answers=[];
  await middleware[0]({from:{id},chat:{type:"private",id:id+1},callbackQuery:{},answerCallbackQuery:async value=>answers.push(value)},()=>assert.fail("must not advance"));
  assert.equal(answers.length,1);
  assert.equal(answers[0].show_alert,true);
 }
 assert.equal(query.mock.callCount(),0);
});

test("post history rejects mismatched private administrator before language lookup",async t=>{
 const commands=[],callbacks=[];
 registerPostHistory({command(name,handler){commands.push(handler);},callbackQuery(pattern,handler){callbacks.push(handler);},on(){}});
 const query=t.mock.method(pool,"query",async()=>assert.fail("must not query"));
 for(const handler of commands){
  const replies=[];
  await handler({from:{id:ownerId},chat:{type:"private",id:ownerId+1},reply:async value=>replies.push(value)});
  assert.deepEqual(replies,["Access denied."]);
 }
 for(const handler of callbacks){
  const answers=[];
  await handler({from:{id:ownerId},chat:{type:"private",id:ownerId+1},answerCallbackQuery:async value=>answers.push(value)});
  assert.equal(answers[0].text,"Unauthorized.");
 }
 assert.equal(query.mock.callCount(),0);
});
