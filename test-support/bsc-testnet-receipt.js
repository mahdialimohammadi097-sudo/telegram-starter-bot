// Offline receipt reader for the deposit simulation. The chain observations,
// token configuration and wallet assignment must come from independent test inputs.
const transferTopic = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const hash = /^0x[0-9a-f]{64}$/i;
const address = /^0x[0-9a-f]{40}$/i;
const quantity = /^0x(?:0|[1-9a-f][0-9a-f]*)$/i;

export function readTestnetTransfer(observation, expected) {
  const { receipt, chainId, finalizedBlockNumber, canonicalBlockHash } = observation;
  if (chainId !== "0x61" || !quantity.test(finalizedBlockNumber) ||
      !quantity.test(receipt?.blockNumber) || BigInt(receipt.blockNumber) > BigInt(finalizedBlockNumber) ||
      receipt.status !== "0x1" || !hash.test(canonicalBlockHash) ||
      receipt.blockHash !== canonicalBlockHash || !hash.test(expected.txHash) ||
      receipt.transactionHash !== expected.txHash || !quantity.test(expected.logIndex)) {
    throw new Error("Receipt identity or finality mismatch");
  }
  if (!address.test(expected.contract) || !address.test(expected.recipient) || /^0x0{40}$/i.test(expected.contract) ||
      /^0x0{40}$/i.test(expected.recipient) || !Number.isInteger(expected.decimals) ||
      expected.decimals < 0 || expected.decimals > 255) {
    throw new Error("Invalid test asset or wallet configuration");
  }
  const matches = receipt.logs.filter(log => quantity.test(log.logIndex) &&
    BigInt(log.logIndex) === BigInt(expected.logIndex));
  const log = matches[0];
  const recipientTopic = "0x" + expected.recipient.slice(2).toLowerCase().padStart(64, "0");
  if (matches.length !== 1 || log.removed !== false ||
      log.transactionHash !== receipt.transactionHash || log.blockHash !== receipt.blockHash ||
      log.blockNumber !== receipt.blockNumber || log.address?.toLowerCase() !== expected.contract.toLowerCase() ||
      log.topics?.length !== 3 || log.topics[0] !== transferTopic ||
      !/^0x0{24}[0-9a-f]{40}$/i.test(log.topics[1]) || log.topics[2]?.toLowerCase() !== recipientTopic ||
      /^0x0{64}$/i.test(log.topics[1]) || log.topics[1].toLowerCase() === recipientTopic ||
      !hash.test(log.data)) {
    throw new Error("Transfer log does not match the configured token and wallet");
  }
  const raw = BigInt(log.data);
  const scale = 10n ** BigInt(expected.decimals);
  const units = raw * 100000000n;
  if (raw === 0n || units % scale !== 0n) throw new Error("Unsupported ledger precision or zero amount");
  const ledgerUnits = units / scale;
  if (ledgerUnits >= 10n ** 26n) throw new Error("Amount exceeds ledger storage");
  const fraction = (ledgerUnits % 100000000n).toString().padStart(8, "0").replace(/0+$/, "");
  const amount = (ledgerUnits / 100000000n).toString() + (fraction ? "." + fraction : "");
  return { event: "97:" + expected.txHash.toLowerCase() + ":" + BigInt(log.logIndex), amount };
}
