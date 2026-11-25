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
  "one read-only snapshot reconciles simulated deposit, investment and withdrawal lifecycle"
]);

export function verifyFinancialTestEvidence(tap) {
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
  for(const name of criticalTests){
    // Require a top-level positive assertion with the complete expected name.
    // A directive such as # SKIP or a mere diagnostic does not count.
    const matches=lines.filter(line=>line.replace(/^ok [1-9][0-9]* - /,"")===name && /^ok [1-9][0-9]* - /.test(line));
    if(matches.length!==1) throw new Error("Missing or ambiguous critical test evidence: "+name);
  }
  return {tests:String(totals.tests),critical:criticalTests.length};
}

if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href){
  try{
    if(process.argv.length!==3) throw new Error("Exactly one TAP evidence file required");
    const result=verifyFinancialTestEvidence(readFileSync(process.argv[2],"utf8"));
    console.log("Verified test evidence: "+result.tests+" passed; "+result.critical+" critical tests present.");
  }catch(error){
    console.error("Financial test evidence verification failed:",error.message);
    process.exitCode=1;
  }
}
