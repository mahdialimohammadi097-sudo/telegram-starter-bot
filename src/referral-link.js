const BOT_USERNAME = "PROFINO1bot";

export function normalizeReferralCode(referralCode) {
  const code = String(referralCode ?? "").trim().toLowerCase();
  return /^[a-f0-9]{16}$/.test(code) ? code : null;
}

export function buildReferralInviteLink(referralCode) {
  const code = normalizeReferralCode(referralCode);
  if (!code) {
    throw new TypeError("Invalid referral code");
  }

  return `https://t.me/${BOT_USERNAME}?start=ref_${code}`;
}
