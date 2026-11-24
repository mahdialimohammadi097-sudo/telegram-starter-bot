import { Keyboard } from "grammy";
import { isPrivateSimulationChat } from "./simulation-chat-safety.js";

// Compatibility with the previously deployed owner-only reply keyboard.
// This does not authorize any action or alter customer-facing English.
const rows = Object.freeze([
 ["My Account","My Wallet"],["Investment Plans","My Investments"],
 ["Deposit","Withdraw"],["Daily Profits","Referral Program"],
 ["Transaction History","Support"]
].map(row=>Object.freeze(row)));
const labels = Object.freeze({
 "My Account":"حساب من","My Wallet":"کیف پول من",
 "Investment Plans":"طرح‌های سرمایه‌گذاری","My Investments":"سرمایه‌گذاری‌های من",
 "Deposit":"واریز","Withdraw":"برداشت","Daily Profits":"سود روزانه",
 "Referral Program":"برنامه معرفی","Transaction History":"تاریخچه تراکنش‌ها",
 "Support":"پشتیبانی","⬅ Main Menu":"⬅ منوی اصلی"
});
function isPrivateOwner(ctx, ownerId) {
 return Number.isSafeInteger(ownerId) && ownerId>0 && isPrivateSimulationChat(ctx) && ctx.from.id===ownerId;
}
export async function getOwnerMenuLanguage(ctx,ownerId,lookup) {
 if(!isPrivateOwner(ctx,ownerId))return "en";
 return await lookup(ctx)==="fa"?"fa":"en";
}
export function canonicalOwnerMenuChoice(ctx,ownerId,choice) {
 if(!isPrivateOwner(ctx,ownerId)||typeof choice!=="string")return choice;
 return Object.keys(labels).find(key=>labels[key]===choice)??choice;
}
export function ownerMainKeyboard(){
 const keyboard=new Keyboard();
 for(const [a,b] of rows)keyboard.text(labels[a]).text(labels[b]).row();
 return keyboard.resized();
}
