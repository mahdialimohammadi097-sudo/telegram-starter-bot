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
