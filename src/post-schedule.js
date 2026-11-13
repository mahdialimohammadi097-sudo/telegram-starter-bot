const persianStatuses = {
  all: "همه", scheduled: "زمان‌بندی‌شده", preview_sending: "در حال ارسال پیش‌نمایش",
  preview_sent: "پیش‌نمایش ارسال‌شده", preview_unknown: "وضعیت پیش‌نمایش نامشخص",
  approved: "تأییدشده", publishing: "در حال انتشار", publish_unknown: "وضعیت انتشار نامشخص",
  published: "منتشرشده", rejected: "ردشده", cancelled: "لغوشده", failed: "ناموفق"
};

export function postStatusLabel(status, language) {
  return language === "fa" && Object.hasOwn(persianStatuses, status) ? persianStatuses[status] : status.toUpperCase();
}

export function parseUtcDateTime(value) {
  const digits = "۰۱۲۳۴۵۶۷۸۹٠١٢٣٤٥٦٧٨٩";
  const normalized = value.replace(/[۰-۹٠-٩]/g, digit => String(digits.indexOf(digit) % 10));
  const match = /^(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2})$/.exec(normalized);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  if (year < 2000 || month < 1 || month > 12 || hour > 23 || minute > 59) return null;
  const date = new Date(Date.UTC(year, month - 1, day, hour, minute, 0));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 ||
      date.getUTCDate() !== day || date.getUTCHours() !== hour ||
      date.getUTCMinutes() !== minute || date.getTime() <= Date.now() + 60000) return null;
  return date;
}
