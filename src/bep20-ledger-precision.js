// Convert BSC token base units to PROFINO's exact 8-decimal USDT ledger.
// No rounding is permitted: nonrepresentable transfers must be reviewed.
const UINT = /^(0|[1-9][0-9]{0,77})$/;
const MAX_UINT256 = (1n << 256n) - 1n;
const SCALE = 10000000000n; // 18 token decimals minus 8 ledger decimals
export function bep20BaseUnitsToLedgerAmount(baseUnits) {
  if (typeof baseUnits !== "string" || !UINT.test(baseUnits)) throw new TypeError("Invalid base units");
  const amount = BigInt(baseUnits);
  if (amount > MAX_UINT256) throw new RangeError("Deposit amount exceeds uint256");
  if (amount <= 0n) throw new Error("Deposit amount must be positive");
  if (amount % SCALE !== 0n) throw new Error("Deposit precision exceeds ledger precision; manual review required");
  const units = amount / SCALE;
  const whole = units / 100000000n;
  const fraction = (units % 100000000n).toString().padStart(8, "0");
  return whole.toString() + "." + fraction;
}
