// Manual, read-only diagnostic via the authorized private runtime connection.
// Never start Telegram, change database objects or process financial operations.
import pg from "pg";
import {resolveDatabaseTls} from "../src/database-tls-policy.js";
import {collectLedgerReleaseEvidence} from "../src/ledger-release-audit.js";

let pool;
let idleFailure=false;
let report;
const failure=reason=>({
  audit:"ledger-release-evidence",checksPassed:false,reason,
  custodyVerified:false,financialActivationReady:false,productionReady:false
});
try{
  if(!process.env.DATABASE_URL){
    report=failure("DATABASE_URL_NOT_CONFIGURED");
    process.exitCode=3;
  }else{
    pool=new pg.Pool({connectionString:process.env.DATABASE_URL,
      ssl:resolveDatabaseTls(),max:1,connectionTimeoutMillis:8000,
      options:"-c default_transaction_read_only=on -c statement_timeout=10000 -c lock_timeout=3000 -c search_path=pg_catalog"});
    pool.on("error",()=>{idleFailure=true;});
    report=await collectLedgerReleaseEvidence(pool);
    if(!report.checksPassed)process.exitCode=2;
  }
}catch{
  report=failure("AUDIT_FAILED");
  process.exitCode=3;
}finally{
  if(pool){
    try{await pool.end();}
    catch{report=failure("AUDIT_CLEANUP_FAILED");process.exitCode=3;}
  }
}
if(idleFailure){report=failure("AUDIT_IDLE_CONNECTION_FAILED");process.exitCode=3;}
process.stdout.write(JSON.stringify(report)+"\n");
