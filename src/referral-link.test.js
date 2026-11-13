import test from "node:test";
import assert from "node:assert/strict";
import { buildReferralInviteLink } from "./referral-link.js";

test("builds a Telegram deep link for a valid referral code", () => {
  assert.equal(
    buildReferralInviteLink("0123456789abcdef"),
    "https://t.me/PROFINO1bot?start=ref_0123456789abcdef"
  );
});

test("normalizes surrounding whitespace in a referral code", () => {
  assert.equal(
    buildReferralInviteLink(" 0123456789abcdef "),
    "https://t.me/PROFINO1bot?start=ref_0123456789abcdef"
  );
});

test("normalizes uppercase hexadecimal codes to the stored lowercase form", () => {
  assert.equal(
    buildReferralInviteLink("ABCDEF0123456789"),
    "https://t.me/PROFINO1bot?start=ref_abcdef0123456789"
  );
});

test("rejects missing, malformed, or non-hex referral codes", () => {
  for (const value of [null, "", "short", "0123456789abcdeg", "0123456789abcdef<script>"]) {
    assert.throws(() => buildReferralInviteLink(value), /Invalid referral code/);
  }
});
