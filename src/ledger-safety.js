const SCALE = 100000000n;

export function toUsdtUnits(value) {
  const raw = String(value ?? "").trim();
  const match = /^([+-]?)(\\d+)(?:\\.(\\d+))?$/.exec(raw);
  if (!match) throw new TypeError("Invalid USDT amount");
  const sign = match[1] === "-" ? -1n : 1n;
  const whole = BigInt(match[2]);
  const fraction = match[3] || "";
  const firstEight = (fraction + "00000000").slice(0, 8);
  let units = whole * SCALE + BigInt(firstEight);
  if (fraction.length > 8 && fraction[8] >= "5") units += 1n;
  return sign * units;
}

export function formatUsdt(value) {
  const units = toUsdtUnits(value);
  const negative = units < 0n;
  const absolute = negative ? -units : units;
  const whole = absolute / SCALE;
  const fraction = String(absolute % SCALE).padStart(8, "0");
  return (negative ? "-" : "") + whole.toString() + "." + fraction;
}

export function assertBalancedLedgerEntries(entries) {
  if (!Array.isArray(entries) || entries.length < 2) {
    throw new Error("A ledger transaction requires at least two entries");
  }
  const totals = new Map();
  for (const entry of entries) {
    const currency = String(entry.currency || "").trim().toUpperCase();
    const type = String(entry.entry_type || "").toLowerCase();
    const amount = toUsdtUnits(entry.amount);
    if (!currency || !["credit", "debit"].includes(type) || amount <= 0n) {
      throw new Error("Invalid ledger entry");
    }
    if (!totals.has(currency)) totals.set(currency, { credit: 0n, debit: 0n });
    totals.get(currency)[type] += amount;
  }
  for (const [currency, total] of totals) {
    if (total.credit !== total.debit) {
      throw new Error("Unbalanced ledger transaction for " + currency);
    }
  }
  return true;
}

export function assertNonNegativeAvailableBalance(balance, debit) {
  const available = toUsdtUnits(balance);
  const requestedDebit = toUsdtUnits(debit);
  if (available < 0n || requestedDebit <= 0n || requestedDebit > available) {
    throw new Error("Insufficient available balance");
  }
  return true;
}
