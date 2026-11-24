import test from "node:test";
import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";
import pg from "pg";
import {Bot} from "grammy";
import {verifyRuntimeSchema} from "./runtime-schema-policy.js";
import {activeOwnerLockBody} from "./restricted-owner-lock.js";
import {postHistoryTriggerBody} from "./post-history-trigger-body.js";
const url=process.env.CATALOG_REHEARSAL_URL;
function safeTarget(){
 if(!url || process.env.PROFINO_DISPOSABLE_POSTGRES!=="yes")return false;
 try {const u=new URL(url);return ["postgres:","postgresql:"].includes(u.protocol) && ["localhost","127.0.0.1","[::1]"].includes(u.hostname) && u.pathname==="/catalog_rehearsal" && !u.search && !u.hash;}catch{return false;}
}
test("restricted role verifies runtime inventory without schema creation rights",{skip:!safeTarget(),timeout:30000},async t=>{
 const nonce=randomUUID().replaceAll("-","");
 const schema="runtime_"+nonce,role="runtime_role_"+nonce;
 const pool=new pg.Pool({connectionString:url,max:2,connectionTimeoutMillis:5000});
 const client=await pool.connect();
 const q=(sql,params)=>client.query(sql,params);
 let madeSchema=false,madeRole=false;
 try{
  await q("CREATE SCHEMA "+schema);madeSchema=true;
  await q("CREATE ROLE "+role+" NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE");madeRole=true;
  await q("SET search_path TO "+schema+",pg_catalog");
  // Operational metadata fixture, not a production migration or full schema contract.
  await q(`CREATE TABLE users(id bigserial PRIMARY KEY,telegram_id bigint UNIQUE,status text,username text,first_name text,last_name text,referral_code text,created_at timestamptz DEFAULT now());
   CREATE TABLE ledger_accounts(id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,user_id bigint,account_code text,account_type text,currency text,UNIQUE(user_id,account_type,currency));
   CREATE TABLE ledger_transactions(id bigint,status text,transaction_type text,reference_id text,created_at timestamptz);
   CREATE TABLE ledger_entries(id bigint,transaction_id bigint,account_id bigint,entry_type text,amount numeric,currency text);
   CREATE TABLE scheduled_posts(id bigserial PRIMARY KEY,title text,content text,status text,scheduled_at timestamptz,updated_at timestamptz,created_at timestamptz,preview_message_id bigint,preview_chat_id bigint,approved_by bigint,published_message_id bigint,published_at timestamptz,cancelled_at timestamptz,cancellation_reason text,edit_version int,last_edited_at timestamptz);
   CREATE TABLE scheduled_post_history(id bigserial PRIMARY KEY,post_id bigint,event_type text,old_status text,new_status text,details jsonb,changed_at timestamptz);
   CREATE TABLE admin_users(user_id bigint,role text,status text);
   CREATE TABLE admin_preferences(user_id bigint PRIMARY KEY,language text,updated_at timestamptz);
   CREATE TABLE admin_audit_logs(id bigserial PRIMARY KEY,admin_user_id bigint,actor_telegram_id bigint,action text,target_user_id bigint,currency text,metadata jsonb,details jsonb,created_at timestamptz DEFAULT now());
   CREATE FUNCTION profino_log_scheduled_post_history() RETURNS trigger LANGUAGE plpgsql AS $history$${postHistoryTriggerBody}$history$;
   CREATE TRIGGER trg_scheduled_post_history AFTER INSERT OR UPDATE ON scheduled_posts FOR EACH ROW EXECUTE FUNCTION profino_log_scheduled_post_history();`);
  await q("INSERT INTO users(telegram_id,status) VALUES (8810232463,'active')");
  await q("INSERT INTO admin_users VALUES (1,'owner','active')");
  await q("CREATE FUNCTION "+schema+".profino_lock_active_owner() RETURNS bigint LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $owner_lock$"+activeOwnerLockBody(schema)+"$owner_lock$");
  await q("REVOKE ALL ON FUNCTION "+schema+".profino_lock_active_owner() FROM PUBLIC");
  await q("GRANT EXECUTE ON FUNCTION "+schema+".profino_lock_active_owner() TO "+role);
  await q("GRANT USAGE ON SCHEMA "+schema+" TO "+role);
  await q("GRANT SELECT ON ALL TABLES IN SCHEMA "+schema+" TO "+role);
  const insertGrants=[
   "users(telegram_id,username,first_name,last_name,referral_code,status)",
   "ledger_accounts(user_id,account_code,account_type,currency)",
   "scheduled_posts(title,content,scheduled_at,status)",
   "scheduled_post_history(post_id,event_type,old_status,new_status,details)",
   "admin_preferences(user_id,language,updated_at)",
   "admin_audit_logs(admin_user_id,actor_telegram_id,action,target_user_id,currency,metadata,details)"
  ];
  const updateGrants=[
   "users(username,first_name,last_name,referral_code,status)",
   "scheduled_posts(title,content,status,scheduled_at,updated_at,preview_message_id,preview_chat_id,approved_by,published_message_id,published_at,cancelled_at,cancellation_reason,edit_version,last_edited_at)",
   "admin_preferences(language,updated_at)"
  ];
  // PostgreSQL GRANT syntax puts the column list before ON.
  for(const [action,grants] of [["INSERT",insertGrants],["UPDATE",updateGrants]]){
   for(const grant of grants){
    const [table,columns]=grant.split("(");
    await q("GRANT "+action+" ("+columns+" ON "+table+" TO "+role);
   }
  }
  for(const name of ["users","scheduled_posts","scheduled_post_history","admin_audit_logs"]){
   await q("GRANT USAGE ON SEQUENCE "+name+"_id_seq TO "+role);
  }
  const adapter={connect:async()=>({query:q,release(error){assert.equal(error,undefined);}})};
  await q("SET ROLE "+role);
  assert.equal((await q("SELECT has_schema_privilege(current_user,$1,'CREATE') AS allowed",[schema])).rows[0].allowed,false);
  assert.deepEqual(await verifyRuntimeSchema(adapter,{schema}),{operationalInventoryVerified:true,financialActivationReady:false});
  await assert.rejects(q("CREATE TABLE "+schema+".forbidden(id int)"),e=>e.code==="42501");
  await assert.rejects(q("UPDATE users SET telegram_id=123 WHERE id=1"),e=>e.code==="42501");
  await assert.rejects(q("INSERT INTO ledger_entries(id) VALUES (1)"),e=>e.code==="42501");
  // Run actual Telegram registration and wallet view against the restricted role.
  const {pool:appPool}=await import("./database.js");
  const {registerCommands}=await import("./commands.js");
  // The isolated fixture lives in a random schema. Redirect only the fixed
  // public owner-lock function identifier; leave all other runtime SQL unchanged.
  const scopedQuery=(sql,params)=>q(sql.replaceAll("public.profino_lock_active_owner()",schema+".profino_lock_active_owner()"),params);
  const mock=t.mock.method(appPool,"query",scopedQuery);
  const envBefore=process.env.PROFINO_RUNTIME_SCHEMA_MODE;
  process.env.PROFINO_RUNTIME_SCHEMA_MODE="verify-only";
  try {
   const bot=new Bot("offline",{botInfo:{id:7,is_bot:true,first_name:"Fixture",username:"offline_bot"}});
   registerCommands(bot);
   const replies=[];
   bot.api.config.use(async(_prev,method,payload)=>{
    assert.ok(["sendMessage","answerCallbackQuery","editMessageText"].includes(method));replies.push(payload.text);return {ok:true,result:true};
   });
   let seq=0;
   async function select(text){
    const id=4321;
    await bot.handleUpdate({update_id:++seq,message:{message_id:seq,date:0,text,
     entities:text==="/start"?[{type:"bot_command",offset:0,length:6}]:[],
     from:{id,is_bot:false,first_name:"Fixture"},chat:{id,type:"private"}}});
    return replies.at(-1);
   }
   assert.match(await select("/start"),/Your account is ready/);
   assert.match(await select("My Wallet"),/Available Balance: 0\.00000000 USDT/);
   assert.match(await select("/start"),/Your account is ready/);
   assert.equal((await q("SELECT count(*)::int AS n FROM ledger_accounts")).rows[0].n,3);
   const {commitUserStatus}=await import("./admin-ops.js");
   const restrictedAdapter={connect:async()=>({query:scopedQuery,release(error){assert.ok(!error);}})};
   const state=async()=> (await q("SELECT status,xmin::text AS version FROM users WHERE telegram_id=4321")).rows[0];
   const before=await state();
   assert.equal(await commitUserStatus("4321","blocked","active",before.version,restrictedAdapter),true);
   assert.equal((await state()).status,"blocked");
   assert.equal(await commitUserStatus("4321","blocked","active",before.version,restrictedAdapter),false);
   const audit=await q("SELECT action,details FROM admin_audit_logs");
   assert.deepEqual(audit.rows,[{action:"user_blocked",details:{old_status:"active",new_status:"blocked"}}]);
   await assert.rejects(q("UPDATE admin_audit_logs SET action='tampered'"),e=>e.code==="42501");
   await q("RESET ROLE");
   await q("UPDATE admin_users SET status='revoked'");
   await q("SET ROLE "+role);
   const blocked=await state();
   await assert.rejects(commitUserStatus("4321","active","blocked",blocked.version,restrictedAdapter),/No active admin_users/);
   assert.deepEqual(await state(),blocked);
   assert.equal((await q("SELECT count(*)::int AS n FROM admin_audit_logs")).rows[0].n,1);
   await q("RESET ROLE");
   await q("UPDATE admin_users SET status='active'");
   await q("SET ROLE "+role);
   await bot.handleUpdate({update_id:++seq,message:{message_id:seq,date:0,text:"/adminlogs",entities:[{type:"bot_command",offset:0,length:10}],
    from:{id:8810232463,is_bot:false,first_name:"Fixture"},chat:{id:8810232463,type:"private"}}});
   assert.match(replies.at(-1),/PROFINO|Activity/);
   assert.equal((await q("SELECT count(*)::int AS n FROM admin_audit_logs WHERE action='admin_activity_viewed'")).rows[0].n,1);
   const inserted=await q("INSERT INTO scheduled_posts(title,content,scheduled_at,status) VALUES ('Fixture','offline',now(),'scheduled') RETURNING id");
   await q("UPDATE scheduled_posts SET status='preview_sent' WHERE id=$1",[inserted.rows[0].id]);
   assert.deepEqual((await q("SELECT event_type FROM scheduled_post_history ORDER BY id")).rows.map(row=>row.event_type),["created","status_changed"]);
   await assert.rejects(q("DELETE FROM scheduled_post_history"),e=>e.code==="42501");
  } finally {
   if(envBefore===undefined)delete process.env.PROFINO_RUNTIME_SCHEMA_MODE;else process.env.PROFINO_RUNTIME_SCHEMA_MODE=envBefore;
   mock.mock.restore();await appPool.end();
  }
  await assert.rejects(q("SELECT user_id FROM admin_users FOR SHARE"),e=>e.code==="42501");
  assert.equal((await q("SELECT "+schema+".profino_lock_active_owner() AS id")).rows[0].id,"1");
  // Prove that the SECURITY DEFINER row lock survives the function call
  // and prevents a concurrent membership revocation until transaction end.
  const revoker=await pool.connect();
  try{
   await q("BEGIN");
   assert.equal((await q("SELECT "+schema+".profino_lock_active_owner() AS id")).rows[0].id,"1");
   await revoker.query("BEGIN");
   await revoker.query("SET LOCAL lock_timeout = '200ms'");
   await assert.rejects(revoker.query("UPDATE "+schema+".admin_users SET status='revoked'"),e=>e.code==="55P03");
   await revoker.query("ROLLBACK");
   await q("COMMIT");
   assert.equal((await revoker.query("UPDATE "+schema+".admin_users SET status='revoked'")).rowCount,1);
  }finally{
   await q("ROLLBACK");
   await revoker.query("ROLLBACK");
   revoker.release(true);
  }
  await q("RESET ROLE");
  await q("SET ROLE "+role);
  assert.equal((await q("SELECT "+schema+".profino_lock_active_owner() AS id")).rows[0].id,null);
  await q("RESET ROLE");
  await q("UPDATE admin_users SET status='active'");
  await q("GRANT EXECUTE ON FUNCTION "+schema+".profino_lock_active_owner() TO PUBLIC");
  await q("SET ROLE "+role);
  await assert.rejects(verifyRuntimeSchema(adapter,{schema}),/owner lock is missing or incompatible/);
  await q("RESET ROLE");
  await q("REVOKE ALL ON FUNCTION "+schema+".profino_lock_active_owner() FROM PUBLIC");
  await q("CREATE OR REPLACE FUNCTION "+schema+".profino_lock_active_owner() RETURNS bigint LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $owner_lock$SELECT 1::bigint$owner_lock$");
  await q("SET ROLE "+role);
  await assert.rejects(verifyRuntimeSchema(adapter,{schema}),/owner lock is missing or incompatible/);
  await q("RESET ROLE");
  await q("CREATE OR REPLACE FUNCTION "+schema+".profino_lock_active_owner() RETURNS bigint LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $owner_lock$"+activeOwnerLockBody(schema)+"$owner_lock$");
  // Test column-level privilege, not only table-level grants.
  await q("GRANT UPDATE(amount) ON ledger_entries TO "+role);
  await q("SET ROLE "+role);
  await assert.rejects(verifyRuntimeSchema(adapter,{schema}),/excessive operational or ledger access/);
  await q("RESET ROLE");
  await q("REVOKE UPDATE(amount) ON ledger_entries FROM "+role);
  await q("GRANT CREATE ON SCHEMA "+schema+" TO "+role);
  await q("SET ROLE "+role);
  await assert.rejects(verifyRuntimeSchema(adapter,{schema}),/excessive database privileges/);
  await q("RESET ROLE");
  await q("REVOKE CREATE ON SCHEMA "+schema+" FROM "+role);
  await q("GRANT UPDATE(telegram_id) ON users TO "+role);
  await q("SET ROLE "+role);
  await assert.rejects(verifyRuntimeSchema(adapter,{schema}),/excessive operational or ledger access/);
  await q("RESET ROLE");
  await q("REVOKE UPDATE(telegram_id) ON users FROM "+role);
  await q("REVOKE USAGE ON SEQUENCE users_id_seq FROM "+role);
  await q("SET ROLE "+role);
  await assert.rejects(verifyRuntimeSchema(adapter,{schema}),/generated ID sequence missing or incompatible/);
  await q("RESET ROLE");
  await q("GRANT USAGE ON SEQUENCE users_id_seq TO "+role);
  await q("GRANT UPDATE ON SEQUENCE users_id_seq TO "+role);
  await q("SET ROLE "+role);
  await assert.rejects(verifyRuntimeSchema(adapter,{schema}),/generated ID sequence missing or incompatible/);
  await q("RESET ROLE");
  await q("REVOKE UPDATE ON SEQUENCE users_id_seq FROM "+role);
  await q("REVOKE INSERT(action) ON admin_audit_logs FROM "+role);
  await q("SET ROLE "+role);
  await assert.rejects(verifyRuntimeSchema(adapter,{schema}),/access or resolution mismatch/);
  await q("RESET ROLE");
  await q("GRANT INSERT(action) ON admin_audit_logs TO "+role);
  await q("ALTER TABLE scheduled_posts DISABLE TRIGGER trg_scheduled_post_history");
  await q("SET ROLE "+role);
  await assert.rejects(verifyRuntimeSchema(adapter,{schema}),/trigger missing or incompatible/);
  await q("RESET ROLE");
  await q("ALTER TABLE scheduled_posts ENABLE TRIGGER trg_scheduled_post_history");
  await q("CREATE OR REPLACE FUNCTION profino_log_scheduled_post_history() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END; $$");
  await q("SET ROLE "+role);
  await assert.rejects(verifyRuntimeSchema(adapter,{schema}),/trigger missing or incompatible/);
  await q("RESET ROLE");
  await q("CREATE OR REPLACE FUNCTION profino_log_scheduled_post_history() RETURNS trigger LANGUAGE plpgsql AS $history$"+postHistoryTriggerBody+"$history$");
  await q("ALTER TABLE admin_preferences DROP COLUMN updated_at");
  await q("SET ROLE "+role);
  await assert.rejects(verifyRuntimeSchema(adapter,{schema}),/object missing/);
 }finally{
  try{await q("RESET ROLE");await q("RESET search_path");if(madeSchema)await q("DROP SCHEMA "+schema+" CASCADE");if(madeRole)await q("DROP ROLE "+role);}
  finally{client.release(true);await pool.end();}
 }
});
