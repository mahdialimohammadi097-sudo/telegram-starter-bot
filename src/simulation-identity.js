// Both simulation key namespaces must use exact positive bigint-compatible IDs.
export function canonicalSimulationIdentity(value) {
  if (typeof value === "number" && !Number.isSafeInteger(value)) {
    throw new TypeError("Unsafe numeric simulation request identity");
  }
  if (!["string", "number", "bigint"].includes(typeof value)) {
    throw new TypeError("Invalid simulation request identity");
  }
  const id = String(value);
  if (!/^[1-9][0-9]{0,18}$/.test(id) || BigInt(id) > 9223372036854775807n) {
    throw new TypeError("Invalid simulation request identity");
  }
  return id;
}
