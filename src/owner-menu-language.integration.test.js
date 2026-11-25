import test from "node:test";
import assert from "node:assert/strict";
import { Bot } from "grammy";

process.env.DATABASE_URL ??= "postgresql://localhost/profino_test";
const { pool } = await import("./database.js");
const { registerCommands } = await import("./commands.js");

test("legacy Persian navigation is private-owner-only in actual grammY command routing", async t => {
 const owner=8810232463, customer=765;
 const queries=[],replies=[];
 t.mock.method(pool,"query",async(sql,params)=>{
  queries.push({sql,params});
  if(sql.includes("SELECT status FROM users"))return {rows:[{status:"active"}],rowCount:1};
  if(sql.includes("WITH registered AS"))return {rows:[{id:"1",status:"active",first_name:"Fixture"}],rowCount:1};
  if(sql.includes("admin_preferences")) {
   assert.equal(params[0],owner);
   return {rows:[{language:"fa"}],rowCount:1};
  }
  throw new Error("Unexpected SQL in offline navigation fixture");
 });
 const bot=new Bot("offline",{botInfo:{id:7,is_bot:true,first_name:"Fixture",username:"offline_bot"}});
 registerCommands(bot);
 bot.api.config.use(async(_prev,method,payload)=>{
  assert.equal(method,"sendMessage");
  replies.push(payload);
  return {ok:true,result:true};
 });
 let sequence=0;
 async function select(id,text,type="private"){
  replies.length=0;
  const chatId=type==="private"?id:-7;
  await bot.handleUpdate({update_id:++sequence,message:{
   message_id:sequence,date:0,text,
   entities:text.startsWith("/")?[{type:"bot_command",offset:0,length:text.length}]:[],
   from:{id,is_bot:false,first_name:"Fixture"},chat:{id:chatId,type}
  }});
  assert.ok(replies.every(reply=>reply.chat_id===chatId));
  return replies.slice();
 }
 const start=await select(owner,"/start");
 assert.match(start[0].text,/حساب شما آماده است/);
 assert.ok(start[0].reply_markup.keyboard.flat().some(button=>button.text==="واریز"));
 const back=await select(owner,"⬅ منوی اصلی");
 assert.equal(back[0].text,"منوی اصلی");
 const before=queries.length;
 assert.deepEqual(await select(owner,"⬅ منوی اصلی","group"),[]);
 assert.equal(queries.length,before);
 const ordinaryStart=await select(customer,"/start");
 assert.match(ordinaryStart[0].text,/Your account is ready/);
 assert.ok(ordinaryStart[0].reply_markup.keyboard.flat().some(button=>button.text==="Deposit"));
 assert.equal((await select(customer,"⬅ منوی اصلی"))[0].text,"Choose an option from the main menu below.");
 await select(owner,"/newpost");
 const draft=await select(owner,"واریز");
 assert.match(draft[0].text,/مرحله ۲ از ۳/);
 await select(owner,"/cancelpost");
 assert.ok(queries.every(query=>!query.sql.includes("INSERT INTO scheduled_posts")));
});
