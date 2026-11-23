// Offline historical assignment gate. Snapshot/current ownership alone is insufficient.
// Caller must supply independently audited, immutable assignment block boundaries.
const uint=value=>typeof value==="string" && /^(0|[1-9][0-9]*)$/.test(value)?BigInt(value):null;
export function inspectHistoricalDepositAssignment({eventBlockNumber,assignment}) {
 const event=uint(eventBlockNumber);
 const start=uint(assignment?.startBlockNumber);
 const end=assignment?.endBlockNumber===null?null:uint(assignment?.endBlockNumber);
 if(event===null || start===null ||
    (assignment?.endBlockNumber!==null && end===null) ||
    (end!==null && end<=start) ||
    event<start || (end!==null && event>=end))
  throw new Error("Deposit address ownership at event block is unverified");
 if(assignment?.historyVerified!==true || assignment?.reassignmentSafe!==true)
  throw new Error("Historical wallet assignment proof is missing");
 return true;
}
