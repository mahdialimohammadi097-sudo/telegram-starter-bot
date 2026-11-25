import test from "node:test";
import assert from "node:assert/strict";
process.env.DATABASE_URL ??= "postgresql://localhost/profino_test";
const {pool}=await import("./database.js");
const {registerAdminOps}=await import("./admin-ops.js");

test("status changes fail closed when audit insertion or transaction completion is uncertain",async t=>{
 const owner=8810232463;
 for(const mode of ["begin-failure","ambiguous-begin","audit-skipped","rollback-failure","ambiguous-rollback","stale-ambiguous-rollback","rolled-back-commit","ambiguous-commit"]){
  const queries=[],releases=[],answers=[];
  const query=t.mock.method(pool,"query",async()=>({rows:[{language:"en"}]}));
  const connect=t.mock.method(pool,"connect",async()=>({
   async query(sql){
    queries.push(sql);
    if(sql==="BEGIN"&&mode==="begin-failure")throw new Error("fixture begin");
    if(sql==="BEGIN"&&mode==="ambiguous-begin")return {};
    if(sql.includes("SELECT id, status, xmin"))return {rowCount:1,rows:[{id:"2",status:"active",version:mode==="stale-ambiguous-rollback"?"8":"7"}]};
    if(sql.includes("FROM admin_users"))return {rowCount:1,rows:[{user_id:"1"}]};
    if(sql.includes("UPDATE users SET status"))return {rowCount:1,rows:[{id:"2"}]};
    if(sql.includes("INSERT INTO admin_audit_logs")){
     if(["rollback-failure","ambiguous-rollback"].includes(mode))throw new Error("fixture audit");
     return {rowCount:mode==="audit-skipped"?0:1};
    }
    if(sql==="ROLLBACK"&&mode==="rollback-failure")throw new Error("fixture rollback");
    if(sql==="ROLLBACK"&&["ambiguous-rollback","stale-ambiguous-rollback"].includes(mode))return {};
    if(sql==="COMMIT")return {command:mode==="ambiguous-commit"?undefined:"ROLLBACK"};
    return {command:sql};
   },release(error){releases.push(error);}
  }));
  try{
   let handler;
   registerAdminOps({command(){},callbackQuery(pattern,fn){if(Array.isArray(pattern)&&pattern.some(p=>p.test("usc:456:blocked:active:7")))handler=fn;}});
   assert.equal(typeof handler,"function");
   await handler({
    from:{id:owner},chat:{id:owner,type:"private"},
    callbackQuery:{data:"usc:456:blocked:active:7"},
    answerCallbackQuery:async value=>answers.push(value)
   });
   assert.equal(answers.length,1);
   assert.equal(answers[0].text,"Unable to update user status.");
   assert.equal(releases.length,1);
   assert.equal(Boolean(releases[0]),mode!=="audit-skipped");
   assert.equal(queries.includes("COMMIT"),["rolled-back-commit","ambiguous-commit"].includes(mode));
   assert.equal(queries.some(sql=>sql.includes("SELECT id, status, xmin")),!["begin-failure","ambiguous-begin"].includes(mode));
   if(mode==="stale-ambiguous-rollback")assert.equal(queries.some(sql=>sql.includes("UPDATE users SET status")),false);
   assert.equal(queries.includes("ROLLBACK"),["audit-skipped","rollback-failure","ambiguous-rollback","stale-ambiguous-rollback"].includes(mode));
  }finally{query.mock.restore();connect.mock.restore();}
 }
});

test("committed admin status change survives Telegram acknowledgement and notification failures", async t => {
 const owner=8810232463;
 const queries=[],releases=[],logs=[],notices=[];
 t.mock.method(console,"error",(...args)=>logs.push(args));
 t.mock.method(pool,"query",async sql=>{
  if(sql.includes("admin_preferences"))return {rows:[{language:"en"}]};
  throw Object.assign(new Error("synthetic-private-detail"),{code:"08006"});
 });
 t.mock.method(pool,"connect",async()=>({
  async query(sql){
   queries.push(sql);
   if(sql==="BEGIN"||sql==="COMMIT"||sql==="ROLLBACK")return {command:sql};
   if(sql.includes("SELECT id, status, xmin"))return {rowCount:1,rows:[{id:"2",status:"active",version:"7"}]};
   if(sql.includes("FROM admin_users"))return {rowCount:1,rows:[{user_id:"1"}]};
   if(sql.includes("UPDATE users SET status"))return {rowCount:1,rows:[{id:"2"}]};
   if(sql.includes("INSERT INTO admin_audit_logs"))return {rowCount:1};
   throw new Error("Unexpected transaction query");
  },
  release(error){releases.push(error);}
 }));
 let handler;
 registerAdminOps({command(){},callbackQuery(pattern,fn){
  if(Array.isArray(pattern)&&pattern.some(p=>p.test("usc:456:blocked:active:7")))handler=fn;
 }});
 assert.equal(typeof handler,"function");
 await handler({
  from:{id:owner},chat:{id:owner,type:"private"},
  callbackQuery:{data:"usc:456:blocked:active:7"},
  answerCallbackQuery:async value=>{
   notices.push(value.text);
   throw Object.assign(new Error("synthetic-private-detail"),{code:"08006"});
  },
  reply:async text=>{
   notices.push(text);
   throw Object.assign(new Error("synthetic-private-detail"),{code:"08006"});
  }
 });
 assert.equal(queries.filter(sql=>sql==="COMMIT").length,1);
 assert.equal(queries.includes("ROLLBACK"),false);
 assert.equal(queries.filter(sql=>sql.includes("INSERT INTO admin_audit_logs")).length,1);
 assert.deepEqual(releases,[null]);
 assert.ok(notices.length>=1);
 assert.ok(notices.every(text=>text.includes("User status updated.")));
 assert.ok(logs.length>=1);
 assert.doesNotMatch(JSON.stringify(logs),/synthetic-private-detail/);
});
