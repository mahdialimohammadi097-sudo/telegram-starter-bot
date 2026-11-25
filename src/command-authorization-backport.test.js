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


test("post management rejects mismatched chat before language lookup or editing sessions",async t=>{
 const {registerPostManagement}=await import("./post-management.js");
 const callbacks=[],messages=[];
 registerPostManagement({callbackQuery(pattern,handler){callbacks.push(handler);},on(event,handler){messages.push(handler);}});
 const query=t.mock.method(pool,"query",async()=>assert.fail("must not query"));
 assert.ok(callbacks.length>0);
 for(const handler of callbacks){
  for(const [chat,message] of [[{type:"private",id:ownerId+1},{chat:{type:"private",id:ownerId}}],[{type:"private",id:ownerId},{chat:{type:"private",id:ownerId+1}}],[{type:"private",id:ownerId},undefined]]){
   const answers=[];
   await handler({from:{id:ownerId},chat,callbackQuery:{data:"post_edit_back:1",message},answerCallbackQuery:async value=>answers.push(value)});
   assert.deepEqual(answers,[{text:"Unauthorized.",show_alert:true}]);
  }
 }
 for(const handler of messages){
  let next=0;
  await handler({from:{id:ownerId},chat:{type:"private",id:ownerId+1}},()=>{next++;});
  assert.equal(next,1);
 }
 assert.equal(query.mock.callCount(),0);
});

test("scheduler callback rejects mismatched private chat before language lookup",async t=>{
 const {startScheduler}=await import("./scheduler.js");
 const handlers=[];
 // Recovery deliberately fails using a synthetic mocked query; no DB or Telegram.
 const query=t.mock.method(pool,"query",async()=>{throw new Error("fixture recovery failure");});
 const scheduler=startScheduler({callbackQuery(pattern,handler){handlers.push(handler);}});
 try{
  assert.equal(await scheduler.ready,false);
  const before=query.mock.callCount();
  assert.equal(handlers.length,1);
  for(const chat of [{type:"private",id:ownerId+1},{type:"group",id:ownerId}]){
   const answers=[];
   await handlers[0]({from:{id:ownerId},chat,callbackQuery:{message:{chat:{type:"private",id:ownerId}},data:"post_reject:1"},answerCallbackQuery:async value=>answers.push(value)});
   assert.deepEqual(answers,[{text:"Unauthorized.",show_alert:true}]);
  }
  assert.equal(query.mock.callCount(),before);
 }finally{scheduler.stop();}
});
