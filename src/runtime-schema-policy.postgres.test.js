import test from "node:test";
import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";
import pg from "pg";
import {verifyRuntimeSchema} from "./runtime-schema-policy.js";
import {activeOwnerLockBody} from "./restricted-owner-lock.js";
const url=process.env.CATALOG_REHEARSAL_URL;
function safeTarget(){
 if(!url || process.env.PROFINO_DISPOSABLE_POSTGRES!=="yes")return false;
 try {const u=new URL(url);return ["postgres:","postgresql:"].includes(u.protocol) && ["localhost","127.0.0.1","[::1]"].includes(u.hostname) && u.pathname==="/catalog_rehearsal" && !u.search && !u.hash;}catch{return false;}
}
test("restricted role verifies runtime inventory without schema creation rights",{skip:!safeTarget(),timeout:20000},async()=>{
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
  await q(`CREATE TABLE users(id bigint,telegram_id bigint,status text,username text,first_name text,last_name text,referral_code text,created_at timestamptz);
   CREATE TABLE ledger_accounts(id bigint,user_id bigint,account_code text,account_type text,currency text);
   CREATE TABLE ledger_transactions(id bigint,status text,transaction_type text,reference_id text,created_at timestamptz);
   CREATE TABLE ledger_entries(id bigint,transaction_id bigint,account_id bigint,entry_type text,amount numeric,currency text);
   CREATE TABLE scheduled_posts(id bigint,title text,content text,status text,scheduled_at timestamptz,updated_at timestamptz,created_at timestamptz,preview_message_id bigint,preview_chat_id bigint,approved_by bigint,published_message_id bigint,published_at timestamptz,cancelled_at timestamptz,cancellation_reason text,edit_version int,last_edited_at timestamptz);
   CREATE TABLE scheduled_post_history(id bigint,post_id bigint,event_type text,old_status text,new_status text,details jsonb,changed_at timestamptz);
   CREATE TABLE admin_users(user_id bigint,role text,status text);
   CREATE TABLE admin_preferences(user_id bigint,language text,updated_at timestamptz);
   CREATE TABLE admin_audit_logs(id bigint,admin_user_id bigint,actor_telegram_id bigint,action text,target_user_id bigint,currency text,metadata jsonb,details jsonb,created_at timestamptz);
   CREATE FUNCTION profino_log_scheduled_post_history() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END; $$;
   CREATE TRIGGER trg_scheduled_post_history AFTER INSERT OR UPDATE ON scheduled_posts FOR EACH ROW EXECUTE FUNCTION profino_log_scheduled_post_history();`);
  await q("INSERT INTO users(id,telegram_id,status) VALUES (1,8810232463,'active')");
  await q("INSERT INTO admin_users VALUES (1,'owner','active')");
  await q("CREATE FUNCTION "+schema+".profino_lock_active_owner() RETURNS bigint LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $owner_lock$"+activeOwnerLockBody(schema)+"$owner_lock$");
  await q("REVOKE ALL ON FUNCTION "+schema+".profino_lock_active_owner() FROM PUBLIC");
  await q("GRANT EXECUTE ON FUNCTION "+schema+".profino_lock_active_owner() TO "+role);
  await q("GRANT USAGE ON SCHEMA "+schema+" TO "+role);
  await q("GRANT SELECT ON ALL TABLES IN SCHEMA "+schema+" TO "+role);
  await q("GRANT INSERT ON ledger_accounts,users,scheduled_posts,scheduled_post_history,admin_preferences,admin_audit_logs TO "+role);
  await q("GRANT UPDATE ON users,scheduled_posts,admin_preferences TO "+role);
  const adapter={connect:async()=>({query:q,release(error){assert.equal(error,undefined);}})};
  await q("SET ROLE "+role);
  assert.equal((await q("SELECT has_schema_privilege(current_user,$1,'CREATE') AS allowed",[schema])).rows[0].allowed,false);
  assert.deepEqual(await verifyRuntimeSchema(adapter,{schema}),{operationalInventoryVerified:true,financialActivationReady:false});
  await assert.rejects(q("CREATE TABLE "+schema+".forbidden(id int)"),e=>e.code==="42501");
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
  await q("REVOKE INSERT ON admin_audit_logs FROM "+role);
  await q("SET ROLE "+role);
  await assert.rejects(verifyRuntimeSchema(adapter,{schema}),/access or resolution mismatch/);
  await q("RESET ROLE");
  await q("GRANT INSERT ON admin_audit_logs TO "+role);
  await q("ALTER TABLE scheduled_posts DISABLE TRIGGER trg_scheduled_post_history");
  await q("SET ROLE "+role);
  await assert.rejects(verifyRuntimeSchema(adapter,{schema}),/trigger missing or incompatible/);
  await q("RESET ROLE");
  await q("ALTER TABLE scheduled_posts ENABLE TRIGGER trg_scheduled_post_history");
  await q("ALTER TABLE admin_preferences DROP COLUMN updated_at");
  await q("SET ROLE "+role);
  await assert.rejects(verifyRuntimeSchema(adapter,{schema}),/object missing/);
 }finally{
  try{await q("RESET ROLE");await q("RESET search_path");if(madeSchema)await q("DROP SCHEMA "+schema+" CASCADE");if(madeRole)await q("DROP ROLE "+role);}
  finally{client.release(true);await pool.end();}
 }
});
