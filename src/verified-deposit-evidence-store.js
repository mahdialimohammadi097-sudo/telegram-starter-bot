import { isCanonicalDepositEventKey } from "./deposit-owner-guard.js";
// Rehearsal-only durable receipt evidence store. Requires a reviewed migration
// and reconciliation before production use. Does not credit user balances.
const HASH=/^0x[0-9a-f]{64}$/;

const ADDRESS=/^0x[0-9a-f]{40}$/;
const UINT=/^(0|[1-9][0-9]{0,77})$/;
const MAX_UINT256=(1n<<256n)-1n;
const matches=(pattern,value)=>typeof value==="string" && pattern.test(value);
const validUint=value=>matches(UINT,value) && BigInt(value)<=MAX_UINT256;
export async function persistVerifiedDepositEvidence(client, evidence) {
  const snapshot={...evidence};
  if (!client || typeof client.query!=="function" ||
      !isCanonicalDepositEventKey(snapshot.eventKey) || !matches(HASH,snapshot.blockHash) ||
      !matches(ADDRESS,snapshot.tokenContract) || !matches(ADDRESS,snapshot.depositAddress) ||
      /^0x0{40}$/.test(snapshot.tokenContract) || /^0x0{40}$/.test(snapshot.depositAddress) ||
      !validUint(snapshot.amountBaseUnits) || snapshot.amountBaseUnits==="0" ||
      !validUint(snapshot.blockNumber)) throw new Error("Invalid verified deposit evidence");
  const values=[snapshot.eventKey,snapshot.blockHash,snapshot.blockNumber,
    snapshot.tokenContract,snapshot.depositAddress,snapshot.amountBaseUnits];
  const result=await client.query(`
    INSERT INTO verified_deposit_evidence
      (event_key,block_hash,block_number,token_contract,deposit_address,amount_base_units)
    VALUES ($1,$2,$3::numeric,$4,$5,$6::numeric)
    ON CONFLICT (event_key) DO NOTHING RETURNING event_key`,values);
  if (result.rowCount===1) return Object.freeze({inserted:true,eventKey:values[0]});
  // The reviewed evidence table is append-only. Replay comparison needs no
  // UPDATE privilege; the posting caller separately serializes each event.
  // Production must verify the immutable guard and effective role privileges.
  const existing=await client.query(`
    SELECT block_hash,block_number::text AS block_number,token_contract,
           deposit_address,amount_base_units::text AS amount_base_units
      FROM verified_deposit_evidence WHERE event_key=$1`,[values[0]]);
  const row=existing.rows[0];
  if (!row || row.block_hash!==values[1] || row.block_number!==values[2] ||
      row.token_contract!==values[3] || row.deposit_address!==values[4] ||
      row.amount_base_units!==values[5]) throw new Error("Conflicting verified deposit evidence");
  return Object.freeze({inserted:false,eventKey:values[0]});
}
