const SCALE = 100000000n;

export function toUsdtUnits(value) {
  const raw = String(value ?? "").trim();
  const match = /^([+-]?)(\d+)(?:\.(\d+))?$/.exec(raw);
  if (!match) throw new TypeError("Invalid USDT amount");
  const sign = match[1] === "-" ? -1n : 1n;
  const whole = BigInt(match[2]);
  const fraction = match[3] || "";
  const firstEight = (fraction + "00000000").slice(0, 8);
  let units = whole * SCALE + BigInt(firstEight);
  if (fraction.length > 8 && fraction[8] >= "5") units += 1n;
  return sign * units;
}

// Financial validation must never round an input into a different amount.
// Keep toUsdtUnits() for display formatting, where rounding to eight places is intentional.
export function toUsdtUnitsExact(value) {
  // Floating-point numbers cannot safely express fractional USDT units.
  // Require an exact decimal string (or an integer BigInt) for financial use.
  if (typeof value === "number" &&
      (!Number.isSafeInteger(value) || !Number.isFinite(value))) {
    throw new TypeError("Financial USDT amount must be an exact decimal string");
  }
  const raw = String(value ?? "").trim();
  const match = /^([+-]?)(\d+)(?:\.(\d+))?$/.exec(raw);
  if (!match) throw new TypeError("Invalid USDT amount");
  // Reject oversized inputs before BigInt parsing to bound CPU and memory use.
  if (match[2].length > 18) {
    throw new RangeError("USDT amount exceeds ledger numeric capacity");
  }
  const fraction = match[3] || "";
  if (fraction.length > 8) {
    throw new RangeError("USDT amount exceeds eight decimal places");
  }
  const sign = match[1] === "-" ? -1n : 1n;
  const whole = BigInt(match[2]);
  const paddedFraction = (fraction + "00000000").slice(0, 8);
  const units = whole * SCALE + BigInt(paddedFraction);
  // PostgreSQL numeric(36,18) stores at most 18 whole digits.
  // Fail before posting instead of depending on a database overflow.
  if (units >= 10n ** 26n) {
    throw new RangeError("USDT amount exceeds ledger numeric capacity");
  }
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
    const currency = entry?.currency;
    const type = entry?.entry_type;
    const amount = toUsdtUnitsExact(entry.amount);
    if (currency !== "USDT" || !["credit", "debit"].includes(type) || amount <= 0n) {
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
  const available = toUsdtUnitsExact(balance);
  const requestedDebit = toUsdtUnitsExact(debit);
  if (available < 0n || requestedDebit <= 0n || requestedDebit > available) {
    throw new Error("Insufficient available balance");
  }
  return true;
}
