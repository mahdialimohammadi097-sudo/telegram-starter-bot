import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { readTestnetTransfer } from "../test-support/bsc-testnet-receipt.js";

const sample = JSON.parse(readFileSync(new URL("../test/fixtures/bsc-testnet-transfer.json", import.meta.url)));
const expected = sample.expected;

test("captured BSC testnet receipt yields the expected event and amount", () => {
  assert.deepEqual(readTestnetTransfer(sample.observation, expected), sample.result);
});

const wrongAddress = "0x" + "11".repeat(20);
const wrongHash = "0x" + "22".repeat(32);
const invalidCases = [
  ["other chain", o => { o.chainId = "0x38"; }],
  ["failed transaction", o => { o.receipt.status = "0x0"; }],
  ["wrong transaction", o => { o.receipt.transactionHash = wrongHash; }],
  ["block not finalized", o => { o.finalizedBlockNumber = "0x0"; }],
  ["replaced block", o => { o.canonicalBlockHash = wrongHash; }],
  ["wrong token", (_, l) => { l.address = wrongAddress; }],
  ["wrong recipient", (_, l) => { l.topics[2] = "0x" + wrongAddress.slice(2).padStart(64, "0"); }],
  ["self transfer", (_, l) => { l.topics[1] = l.topics[2]; }],
  ["mint", (_, l) => { l.topics[1] = "0x" + "0".repeat(64); }],
  ["removed log", (_, l) => { l.removed = true; }],
  ["foreign block log", (_, l) => { l.blockHash = wrongHash; }],
  ["wrong signature", (_, l) => { l.topics[0] = wrongHash; }],
  ["duplicate log index", (o, l) => { o.receipt.logs.push(structuredClone(l)); }],
  ["event from another transaction", (_, l) => { l.transactionHash = wrongHash; }],
  ["unrelated event index", (_, l) => { l.logIndex = "0xfeed"; }],
  ["oversized amount", (_, l) => { l.data = "0x" + "f".repeat(64); }],
  ["zero amount", (_, l) => { l.data = "0x" + "0".repeat(64); }],
  ["sub-unit amount", (_, l, config) => { config.decimals = 18; l.data = "0x" + "1".padStart(64, "0"); }]
];

for (const [name, mutate] of invalidCases) {
  test("reject receipt with " + name, () => {
    const observation = structuredClone(sample.observation);
    const config = { ...expected };
    const log = observation.receipt.logs.find(item => item.logIndex === config.logIndex);
    mutate(observation, log, config);
    assert.throws(() => readTestnetTransfer(observation, config));
  });
}
