const BOT_USERNAME = "PROFINO1bot";

export function buildReferralInviteLink(referralCode) {
  const code = String(referralCode ?? "").trim();
  if (!/^[a-f0-9]{16}$/i.test(code)) {
    throw new TypeError("Invalid referral code");
  }

  return `https://t.me/${BOT_USERNAME}?start=ref_${code}`;
}
