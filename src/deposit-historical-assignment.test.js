import test from "node:test";
import assert from "node:assert/strict";
import {inspectHistoricalDepositAssignment} from "./deposit-historical-assignment.js";
const assignment={startBlockNumber:"100",endBlockNumber:"200",historyVerified:true,reassignmentSafe:true};
test("accepts independently attested ownership interval at event block",()=>{
 assert.equal(inspectHistoricalDepositAssignment({eventBlockNumber:"100",assignment}),true);
 assert.equal(inspectHistoricalDepositAssignment({eventBlockNumber:"199",assignment}),true);
});
test("rejects missing history, stale ownership and invalid intervals",()=>{
 for(const value of [
  {eventBlockNumber:"99",assignment},
  {eventBlockNumber:"200",assignment},
  {eventBlockNumber:"150",assignment:{...assignment,historyVerified:false}},
  {eventBlockNumber:"150",assignment:{...assignment,reassignmentSafe:false}},
  {eventBlockNumber:"150",assignment:{...assignment,endBlockNumber:"100"}},
  {eventBlockNumber:"150",assignment:{...assignment,startBlockNumber:undefined}},
  {eventBlockNumber:"150",assignment:{...assignment,endBlockNumber:undefined}}
 ])assert.throws(()=>inspectHistoricalDepositAssignment(value),/ownership|proof/);
});
