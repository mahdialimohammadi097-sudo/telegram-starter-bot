import test from "node:test";
import assert from "node:assert/strict";

// This test never connects to PostgreSQL or Telegram. Override the URL before
// the runtime module is imported and replace its query method before invoking handlers.
process.env.DATABASE_URL = "postgresql://fixture:fixture@127.0.0.1:1/diagnostic_fixture";
const { pool } = await import("./database.js");
const { registerAdminOps } = await import("./admin-ops.js");
const ownerId = 8810232463;

function handlers() {
 const commands = new Map(), callbacks = [];
 registerAdminOps({
  command(name, handler) { commands.set(name, handler); },
  callbackQuery(pattern, handler) { callbacks.push({pattern,handler}); }
 });
 return {commands,callbacks};
}

test("admin commands reject non-owner, group and mismatched private chat before querying", async t => {
 const {commands,callbacks}=handlers();
 const query=t.mock.method(pool,"query",async()=>assert.fail("Unauthorized update must not reach database"));
 for(const [from,chat] of [
  [{id:ownerId},{type:"private",id:ownerId+1}],
  [{id:ownerId},{type:"group",id:-1}],
  [{id:ownerId+1},{type:"private",id:ownerId+1}],
  [undefined,{type:"private",id:ownerId}]
 ]){
  for(const handler of commands.values()){
   const replies=[];
   await handler({from,chat,reply:async message=>replies.push(message)});
   assert.deepEqual(replies,["Access denied."]);
  }
  for(const {handler} of callbacks){
   const answers=[];
   await handler({from,chat,answerCallbackQuery:async result=>answers.push(result)});
   assert.equal(answers.length,1);
   assert.equal(answers[0].text,"Unauthorized.");
  }
 }
 assert.equal(query.mock.callCount(),0);
});

test("dbschema failure emits only diagnostic code in English and Persian",async t=>{
 const {commands}=handlers();
 const logs=[];
 t.mock.method(console,"error",(...args)=>logs.push(args));
 for(const language of ["en","fa"]){
  const secret="fixture-private-connection-string";
  const failure=Object.assign(new Error(secret),{code:"28P01",detail:secret,stack:secret});
  const query=t.mock.method(pool,"query",async sql=>{
   if(sql.includes("admin_preferences")) return {rows:[{language}]};
   throw failure;
  });
  const replies=[];
  await commands.get("dbschema")({from:{id:ownerId},chat:{type:"private",id:ownerId},reply:async message=>replies.push(message)});
  assert.equal(replies.length,1);
  assert.match(replies[0],/28P01$/);
  assert.ok(!JSON.stringify([replies,logs]).includes(secret));
  assert.deepEqual(logs.at(-1),["[admin-ops] core database schema inspection failed:","28P01"]);
  query.mock.restore();
 }
});
