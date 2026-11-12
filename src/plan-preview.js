import { toUsdtUnitsExact } from "./ledger-safety.js";

const plans = new Map([
  ["STARTER", { days: 10, profitPercent: 4, feePercent: 2 }],
  ["SMART", { days: 30, profitPercent: 14, feePercent: 4 }],
  ["PRO", { days: 90, profitPercent: 40, feePercent: 6 }]
]);
const amounts = new Set(["10", "25", "50", "75", "100"]);

function decimal(units) {
  const digits = units.toString().padStart(9, "0");
  const fraction = digits.slice(-8).replace(/0+$/, "");
  return digits.slice(0, -8) + (fraction ? "." + fraction : "");
}

export function previewSettlement(input) {
  const [name, amount, ...extra] = String(input ?? "").trim().toUpperCase().split(/\s+/);
  const plan = plans.get(name);
  if (!plan || !amounts.has(amount) || extra.length) return null;
  return { name, ...plan, amount, ...settlementAmounts(amount, plan.profitPercent, plan.feePercent) };
}

export function settlementAmounts(amount, profitPercent, feePercent) {
  const principal = toUsdtUnitsExact(amount);
  const profit = principal * BigInt(profitPercent) / 100n;
  const gross = principal + profit;
  const fee = gross * BigInt(feePercent) / 100n;
  return { profit: decimal(profit), gross: decimal(gross),
    fee: decimal(fee), payout: decimal(gross - fee) };
}
