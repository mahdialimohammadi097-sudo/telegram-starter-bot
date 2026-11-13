import assert from "node:assert/strict";
import test from "node:test";
import { parseUtcDateTime, postStatusLabel } from "./post-schedule.js";

test("schedule creation, edits and restores accept the same UTC digits and calendar dates", () => {
  for (const text of ["2096-02-29 23:59", "۲۰۹۶-۰۲-۲۹ ۲۳:۵۹", "٢٠٩٦-٠٢-٢٩ ٢٣:٥٩"]) {
    assert.equal(parseUtcDateTime(text).toISOString(), "2096-02-29T23:59:00.000Z");
  }
  for (const text of ["۲۰۹۹-۰۲-۲۹ ۱۲:۰۰", "2099-12-31 24:00", "2001-01-01 12:00"]) {
    assert.equal(parseUtcDateTime(text), null);
  }
  assert.equal(postStatusLabel("preview_sending", "fa"), "در حال ارسال پیش‌نمایش");
  assert.equal(postStatusLabel("publish_unknown", "en"), "PUBLISH_UNKNOWN");
});
