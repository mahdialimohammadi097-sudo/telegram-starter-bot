import test from "node:test";
import assert from "node:assert/strict";
import {draftBscDepositJournal} from "./deposit-ledger-journal-draft.js";
import {validateDepositPostingDraft} from "./deposit-posting-invariants.js";
const make=()=>structuredClone(draftBscDepositJournal({evidence:{eventKey:"bsc:56:0x"+"a".repeat(64)+":0",userId:"1",walletId:"2",units:"1000000000"},userAvailableAccountId:"3",platformClearingAccountId:"4"}));
test("valid deposit draft passes",()=>assert.equal(validateDepositPostingDraft(make()),true));
for(const [name,mutate] of [
 ["duplicate accounts",d=>d.entries[1].account_id=d.entries[0].account_id],
 ["wrong identity",d=>d.idempotencyKey="other"],
 ["unbalanced amount",d=>d.entries[1].amount="9.00000000"],
 ["zero amounts",d=>d.entries.forEach(e=>e.amount="0")],
 ["invalid user",d=>d.userId="0"],
 ["invalid wallet",d=>d.walletId="9223372036854775808"],
 ["foreign currency",d=>d.entries.forEach(e=>e.currency="BTC")],
 ["reversed legs",d=>d.entries.reverse()],
 ["extra leg",d=>d.entries.push(d.entries[0])]
])test("rejects "+name,()=>{const d=make();mutate(d);assert.throws(()=>validateDepositPostingDraft(d));});

test("rejects noncanonical event identities even with matching idempotency keys",()=>{
 for(const index of ["4294967296","01","1\n","9".repeat(1000)]){
  const d=make();d.eventKey="bsc:56:0x"+"a".repeat(64)+":"+index;
  d.idempotencyKey="deposit:"+d.eventKey;
  assert.throws(()=>validateDepositPostingDraft(d));
 }
});

test("rejects whitespace in every posting identifier",()=>{
 for(const mutate of [d=>d.userId+="\n",d=>d.walletId+="\n",d=>d.entries[0].account_id+="\n",d=>d.entries[1].account_id+="\n"]){const d=make();mutate(d);assert.throws(()=>validateDepositPostingDraft(d));}
});
