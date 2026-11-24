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
