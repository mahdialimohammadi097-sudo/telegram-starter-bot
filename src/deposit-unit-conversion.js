// Pure, offline conversion only. Never credits accounts or enables deposits.
// Contract decimals must be independently verified for the configured token.
const LEDGER_DECIMALS = 8;
export function convertDepositBaseUnitsToLedgerUnits(amountBaseUnits, tokenDecimals) {
 if (typeof amountBaseUnits !== "string" || !/^[1-9][0-9]{0,77}$/.test(amountBaseUnits)) {
  throw new TypeError("Invalid positive integer token base units");
 }
 if (!Number.isInteger(tokenDecimals) || tokenDecimals < 0 || tokenDecimals > 36) {
  throw new TypeError("Invalid token decimals");
 }
 const baseUnits = BigInt(amountBaseUnits);
 // ledger_entries.amount is numeric(36,18): at most 18 integer digits.
 const maxLedgerUnits = 10n ** 26n - 1n;
 const shift = tokenDecimals - LEDGER_DECIMALS;
 if (shift > 0) {
  const divisor = 10n ** BigInt(shift);
  if (baseUnits % divisor !== 0n) throw new RangeError("Deposit cannot be represented exactly in ledger precision");
  const ledgerUnits = baseUnits / divisor;
  if (ledgerUnits > maxLedgerUnits) throw new RangeError("Deposit exceeds ledger numeric capacity");
  return ledgerUnits.toString();
 }
 const ledgerUnits = baseUnits * (10n ** BigInt(-shift));
 if (ledgerUnits > maxLedgerUnits) throw new RangeError("Deposit exceeds ledger numeric capacity");
 return ledgerUnits.toString();
}
