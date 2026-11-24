import { canonicalSimulationIdentity } from "./simulation-identity.js";

// Telegram message IDs are unique within a chat, not globally across all customers.
export function simulationRequestKey(kind, userId, messageId) {
  if (!["investment", "withdrawal"].includes(kind)) throw new Error("Unknown simulation request kind");
  return `telegram-${kind}:${canonicalSimulationIdentity(userId)}:${canonicalSimulationIdentity(messageId)}`;
}
