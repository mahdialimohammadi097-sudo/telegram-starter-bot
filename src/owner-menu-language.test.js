import test from "node:test";
import assert from "node:assert/strict";
import {getOwnerMenuLanguage,canonicalOwnerMenuChoice,ownerMainKeyboard} from "./owner-menu-language.js";
const owner=123;
const privateContext=id=>({from:{id},chat:{id,type:"private"}});
test("only the authenticated private owner can use Persian menu navigation",async()=>{
 let reads=0;
 const lookup=async()=>{reads++;return "fa"};
 const ctx=privateContext(owner);
 assert.equal(await getOwnerMenuLanguage(ctx,owner,lookup),"fa");
 assert.equal(canonicalOwnerMenuChoice(ctx,owner,"واریز"),"Deposit");
 assert.equal(canonicalOwnerMenuChoice(ctx,owner,"⬅ منوی اصلی"),"⬅ Main Menu");
 for(const denied of [privateContext(124),privateContext("123"),{from:{id:owner},chat:{id:124,type:"private"}},{from:{id:owner},chat:{id:owner,type:"group"}},{}]){
  assert.equal(await getOwnerMenuLanguage(denied,owner,lookup),"en");
  assert.equal(canonicalOwnerMenuChoice(denied,owner,"واریز"),"واریز");
 }
 assert.equal(reads,1);
 assert.equal(await getOwnerMenuLanguage(ctx,owner,async()=>"invalid"),"en");
});
test("all previous Persian main menu buttons route to existing handlers",()=>{
 const expected=["My Account","My Wallet","Investment Plans","My Investments","Deposit","Withdraw","Daily Profits","Referral Program","Transaction History","Support"];
 const keys=ownerMainKeyboard().keyboard.flat().map(button=>button.text);
 assert.deepEqual(keys.map(label=>canonicalOwnerMenuChoice(privateContext(owner),owner,label)),expected);
 assert.equal(canonicalOwnerMenuChoice(privateContext(owner),owner,"arbitrary draft text"),"arbitrary draft text");
});
