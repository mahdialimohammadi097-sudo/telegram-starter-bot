import test from "node:test";
import assert from "node:assert/strict";
import {OWNER_ID,menuLanguage,canonicalMenuChoice,ownerMenuText,sectionText,menuTitle} from "./owner-menu-language.js";
test("only owner can use Persian menu",()=>{
 assert.equal(menuLanguage(OWNER_ID,"fa"),"fa");
 assert.equal(menuLanguage(OWNER_ID,"en"),"en");
 assert.equal(menuLanguage(12345,"fa"),"en");
});
test("Persian labels route to canonical handlers",()=>{
 for(const key of ["My Account","My Wallet","Investment Plans","My Investments","Deposit","Withdraw","Daily Profits","Referral Program","Transaction History","Support","⬅ Main Menu"]) {
  assert.equal(canonicalMenuChoice(ownerMenuText(key,"fa")),key);
  assert.equal(canonicalMenuChoice(key),key);
 }
});
test("customers keep English and deposit remains disabled",()=>{
 assert.equal(menuTitle("en"),"Main Menu");
 assert.match(sectionText("Deposit","en"),/not enabled yet/);
 assert.match(sectionText("Deposit","fa"),/هنوز فعال نیست/);
 assert.equal(sectionText("unknown","fa"),null);
});
