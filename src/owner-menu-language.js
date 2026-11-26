import { Keyboard } from "grammy";

export const OWNER_ID = 8810232463;
export const MENU_LABELS = Object.freeze({
 "My Account":"حساب من","My Wallet":"کیف پول من",
 "Investment Plans":"طرح‌های سرمایه‌گذاری","My Investments":"سرمایه‌گذاری‌های من",
 "Deposit":"واریز","Withdraw":"برداشت",
 "Daily Profits":"سود روزانه","Referral Program":"برنامه معرفی",
 "Transaction History":"تاریخچه تراکنش‌ها","Support":"پشتیبانی",
 "⬅ Main Menu":"⬅ منوی اصلی"
});
const EN_ROWS=[
 ["My Account","My Wallet"],["Investment Plans","My Investments"],
 ["Deposit","Withdraw"],["Daily Profits","Referral Program"],
 ["Transaction History","Support"]
];
export function menuLanguage(userId, preference) {
 return Number(userId)===OWNER_ID && preference==="fa"?"fa":"en";
}
export function canonicalMenuChoice(value) {
 return Object.keys(MENU_LABELS).find(k=>k===value || MENU_LABELS[k]===value) ?? value;
}
export function ownerMenuText(value, language) {
 return language==="fa" ? MENU_LABELS[value] ?? value : value;
}
export function mainKeyboard(language="en") {
 const keyboard=new Keyboard();
 for(const [a,b] of EN_ROWS) keyboard.text(ownerMenuText(a,language)).text(ownerMenuText(b,language)).row();
 return keyboard.resized();
}
export function backKeyboard(language="en") {
 return new Keyboard().text(ownerMenuText("⬅ Main Menu",language)).resized();
}
export function menuTitle(language="en") {return language==="fa"?"منوی اصلی":"Main Menu";}
export function sectionText(choice,language="en") {
 const sections={
 "Investment Plans":["INVESTMENT PLANS\n\nAvailable plans will appear here after configuration and verification.","طرح‌های سرمایه‌گذاری\n\nطرح‌های موجود پس از تنظیم و تأیید در این بخش نمایش داده می‌شوند."],
 "My Investments":["MY INVESTMENTS\n\nYour active investments will appear here.","سرمایه‌گذاری‌های من\n\nسرمایه‌گذاری‌های فعال شما در این بخش نمایش داده می‌شوند."],
 "Deposit":["DEPOSIT\n\nAutomatic deposit verification is not enabled yet. Do not send funds until an official deposit address is displayed.","واریز\n\nتأیید خودکار واریز هنوز فعال نیست. تا زمانی که آدرس رسمی واریز نمایش داده نشده، وجهی ارسال نکنید."],
 "Withdraw":["WITHDRAW\n\nWithdrawal services are not enabled yet.","برداشت\n\nخدمات برداشت هنوز فعال نشده‌اند."],
 "Daily Profits":["DAILY PROFITS\n\nVerified profit records will appear here when available.","سود روزانه\n\nسوابق سود تأییدشده پس از آماده‌شدن در این بخش نمایش داده می‌شوند."],
 "Referral Program":["REFERRAL PROGRAM\n\nYour referral details will appear here.","برنامه معرفی\n\nجزئیات معرفی شما در این بخش نمایش داده می‌شوند."],
 "Transaction History":["TRANSACTION HISTORY\n\nYour transaction records will appear here.","تاریخچه تراکنش‌ها\n\nسوابق تراکنش‌های شما در این بخش نمایش داده می‌شوند."],
 "Support":["PROFINO Management — SUPPORT\n\nPlease contact our support team.","PROFINO Management — پشتیبانی\n\nلطفاً با تیم پشتیبانی تماس بگیرید."]
 };
 return sections[choice]?.[language==="fa"?1:0]??null;
}
