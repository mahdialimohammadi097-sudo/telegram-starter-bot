// CI-only evidence check for the Node TAP reporter. Never a release authorization.
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export const criticalTests=Object.freeze([
  "staged evidence migration creates constrained table and refuses existing relations",
  "concurrent investment and withdrawal cannot spend the same available funds",
  "two due investments competing for one profit reserve settle only once until replenished",
  "withdrawal cancellation and synthetic submission race cannot both release and send",
  "investment opening and settlement survive lost commit acknowledgements exactly once",
  "synthetic payout receipt confirmation recovers after a lost commit without a second send",
  "offline recovery rejects a corrupted held-account reference before transport access",
  "withdrawal schema rejects invalid state combinations and duplicate identities in PostgreSQL",
  "one read-only snapshot reconciles simulated deposit, investment and withdrawal lifecycle",
  "restricted role verifies runtime inventory without schema creation rights",
  "restricted startup options apply to two independent PostgreSQL pool connections",
  "restricted checkout rejects reused session drift before application queries",
  "restricted pool discards unfinished and aborted transactions without committing",
  "access audit detects column-level, PUBLIC and delegable ledger privileges",
  "access audit distinguishes session role paths, callable privileged routines and ledger function ownership",
  "PostgreSQL audit verifies effective settings and cannot write ordinary tables",
  "ledger integrity detects blank and padded identities, unused non-USDT accounts and non-finite amounts",
  "ledger catalog audit detects disabled or missing financial guards without mutating them",
  "combined ledger release evidence rejects incomplete or non-table relations",
  "wallet balance rejects duplicate account roles instead of combining them",
  "access catalog audit resists caller name-operator shadowing without changing session identity",
  "access audit distinguishes unexpected named relations from permanent ordinary ledger tables",
  "standalone ledger integrity refuses views, unlogged relations, inheritance and rewrite rules",
  "standalone ledger integrity rejects enabled, forced and dormant row security policies even for an elevated audit role",
  "ledger integrity detects negative platform reserve and mixed-case protected customer accounts",
  "standalone ledger integrity detects ambiguous primary identities without relying on constraints"
]);

export const startupTests=Object.freeze([
  "misconfigured staging production bot cannot reach schema preparation or Telegram writes",
  "misconfigured staging wrong database cannot reach schema preparation or Telegram writes"
]);

export const fullAuditTests=Object.freeze([
  "database access diagnostic publishes one report after path-drift",
  "database access diagnostic publishes one report after incompatible-shape",
  "integrity audit rejects absent or incompatible relations before financial row inspection",
  "integrity audit rejects unknown or unreviewed row visibility before reading financial rows",
  "integrity audit treats negative protected noncustomer balances as discrepancies",
  "integrity audit rejects duplicate or missing row identity evidence",
  "manual ledger catalog export uses a bounded catalog-first read-only snapshot",
  "owner rehearsal requires exact intermediate reservation movement and rejects cancelled replay",
  "owner rehearsal publishes success only after isolated connection cleanup"
]);

export function verifyFinancialTestEvidence(tap, {full=false}={}) {
  if(typeof tap!=="string") throw new Error("Missing TAP evidence");
  const lines=tap.split(/\r?\n/);
  const totals={};
  for(const key of ["tests","pass","fail","cancelled","skipped","todo"]){
    const matches=lines.filter(line=>line.startsWith("# "+key+" "));
    const match=matches.length===1 && /^# [a-z]+ (0|[1-9][0-9]*)$/.exec(matches[0]);
    if(!match) throw new Error("Missing or ambiguous TAP total: "+key);
    totals[key]=BigInt(match[1]);
  }
  if(totals.tests===0n || totals.pass!==totals.tests ||
     ["fail","cancelled","skipped","todo"].some(key=>totals[key]!==0n)){
    throw new Error("Financial test evidence is not entirely successful");
  }
  if(lines.some(line=>/^\s*not ok\b/.test(line))) throw new Error("Failed TAP assertion");
  const required=[...criticalTests, "staging preflight rejects permissive or unvalidated withdrawal state constraints", ...(full?[...startupTests,...fullAuditTests]:[])];
  for(const name of required){
    // Require a top-level positive assertion with the complete expected name.
    // A directive such as # SKIP or a mere diagnostic does not count.
    const matches=lines.filter(line=>line.replace(/^ok [1-9][0-9]* - /,"")===name && /^ok [1-9][0-9]* - /.test(line));
    if(matches.length!==1) throw new Error("Missing or ambiguous critical test evidence: "+name);
  }
  return {tests:String(totals.tests),critical:required.length};
}

if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href){
  try{
    if(process.argv.length!==3 && !(process.argv.length===4 && process.argv[3]==="--full")) {
      throw new Error("One TAP evidence file and optional --full required");
    }
    const result=verifyFinancialTestEvidence(readFileSync(process.argv[2],"utf8"),{full:process.argv[3]==="--full"});
    console.log("Verified test evidence: "+result.tests+" passed; "+result.critical+" critical tests present.");
  }catch(error){
    console.error("Financial test evidence verification failed:",error.message);
    process.exitCode=1;
  }
}
