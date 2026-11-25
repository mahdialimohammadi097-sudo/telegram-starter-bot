// Offline arithmetic only. Inputs must be independent, complete, independently
// authenticated, and aligned to one reconciled cutoff before any interpretation.
// This function cannot establish wallet control, completeness, or solvency.
// Do not include borrowed, pledged, inaccessible or otherwise encumbered assets.
const LEDGER = /^(0|[1-9][0-9]{0,35})(?:\.([0-9]{1,8}))?$/;
const TOKEN = /^(0|[1-9][0-9]{0,77})$/;
function units(value) {
  if(typeof value!=="string" || !LEDGER.test(value)) throw new Error("Invalid exact liability amount");
  const [whole,fraction=""]=value.split(".");
  return BigInt(whole)*10n**18n+BigInt(fraction.padEnd(18,"0"));
}
function assetUnits(value) {
  if(typeof value!=="string" || !TOKEN.test(value) || BigInt(value)>((1n<<256n)-1n)) {
    throw new Error("Invalid exact asset base units");
  }
  return BigInt(value);
}
export function compareSyntheticCustody({available,invested,profit,withdrawalHold,otherObligations,unencumberedAssetsBaseUnits}) {
  const liabilities=[available,invested,profit,withdrawalHold,otherObligations].reduce((sum,v)=>sum+units(v),0n);
  const assets=assetUnits(unencumberedAssetsBaseUnits);
  const delta=assets-liabilities;
  return {scope:"offline-synthetic-arithmetic-only",liabilitiesBaseUnits:liabilities.toString(),
    assetsBaseUnits:assets.toString(),shortfallBaseUnits:(delta<0n?-delta:0n).toString(),
    surplusBaseUnits:(delta>0n?delta:0n).toString(),arithmeticCovered:delta>=0n,
    custodyVerified:false,productionReady:false};
}
