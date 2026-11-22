// Rehearsal-only durable receipt evidence store. Requires a reviewed migration
// and reconciliation before production use. Does not credit user balances.
const HASH=/^0x[0-9a-f]{64}$/;
const KEY=/^bsc:56:0x[0-9a-f]{64}:(?:0|[1-9][0-9]*)$/;
const ADDRESS=/^0x[0-9a-f]{40}$/;
const UINT=/^(0|[1-9][0-9]*)$/;
export async function persistVerifiedDepositEvidence(client, evidence) {
  if (!client || typeof client.query!=="function" || !evidence ||
      !KEY.test(evidence.eventKey ?? "") || !HASH.test(evidence.blockHash ?? "") ||
      !ADDRESS.test(evidence.tokenContract ?? "") || !ADDRESS.test(evidence.depositAddress ?? "") ||
      !UINT.test(evidence.amountBaseUnits ?? "") || BigInt(evidence.amountBaseUnits)===0n ||
      !UINT.test(evidence.blockNumber ?? "")) throw new Error("Invalid verified deposit evidence");
  const values=[evidence.eventKey,evidence.blockHash,evidence.blockNumber,
    evidence.tokenContract,evidence.depositAddress,evidence.amountBaseUnits];
  const result=await client.query(`
    INSERT INTO verified_deposit_evidence
      (event_key,block_hash,block_number,token_contract,deposit_address,amount_base_units)
    VALUES ($1,$2,$3::numeric,$4,$5,$6::numeric)
    ON CONFLICT (event_key) DO NOTHING RETURNING event_key`,values);
  if (result.rowCount===1) return Object.freeze({inserted:true,eventKey:evidence.eventKey});
  const existing=await client.query(`
    SELECT block_hash,block_number::text AS block_number,token_contract,
           deposit_address,amount_base_units::text AS amount_base_units
      FROM verified_deposit_evidence WHERE event_key=$1 FOR UPDATE`,[evidence.eventKey]);
  const row=existing.rows[0];
  if (!row || row.block_hash!==values[1] || row.block_number!==values[2] ||
      row.token_contract!==values[3] || row.deposit_address!==values[4] ||
      row.amount_base_units!==values[5]) throw new Error("Conflicting verified deposit evidence");
  return Object.freeze({inserted:false,eventKey:evidence.eventKey});
}
