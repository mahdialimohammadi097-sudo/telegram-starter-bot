import { canonicalSimulationIdentity } from "./simulation-identity.js";

export function simulationRequestKey(kind, telegramId, messageId) {
  if (!["telegram-preview", "telegram-withdraw"].includes(kind)) {
    throw new TypeError("Unsupported simulation request kind");
  }
  return kind + ":" + canonicalSimulationIdentity(telegramId) + ":" + canonicalSimulationIdentity(messageId);
}
